/** Home-scoped pstack preferences; route authorization remains host-owned. */
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertHumanApproval } from '@deepseek-ai/dsh-tool-subagent'
import type { HumanApproval } from '@deepseek-ai/dsh-tool-subagent'
import type { RouteConfig } from './index.ts'

/** Persisted preferences shared by every profile and working directory. */
export interface PstackPreferences {
  version: 1
  /** Explicit external root; omission follows the current package's bundled resources. */
  root?: string
  modelAliases: Record<string, RouteConfig>
  roles: Record<string, string>
  defaultEffort?: string
  sessionHook?: boolean
  /** Operator-owned exact routes; the model-facing save tool cannot change these. */
  allowedModels: Array<{ provider: string; model: string }>
}

/** Locate the shared pstack preferences file.
 * @returns the canonical home-scoped preferences filename.
 */
export function pstackConfigPath(): string {
  return join(resolveDshHome(), 'pstack', 'config.json')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value)
}

function isModelAlias(alias: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(alias) && !['auto', 'inherit-parent', '__proto__', 'constructor', 'prototype'].includes(alias)
}

/** Accept role names shared by saved JSON and legacy sheets.
 * @param role - candidate role name.
 * @returns whether the name is a nonreserved role beginning with a letter.
 */
export function isPstackRole(role: string): boolean {
  return /^[a-z][a-z0-9 ,_-]*$/.test(role) && !['session hook', 'constructor', 'prototype'].includes(role)
}

/** Validate file/tool JSON without accepting relative installation paths or ambiguous aliases.
 * @param value - parsed JSON preferences.
 * @returns validated preferences.
 */
export function parsePstackPreferences(value: unknown): PstackPreferences {
  if (!record(value) || value.version !== 1 || (value.root !== undefined && (typeof value.root !== 'string' || !isAbsolute(value.root)))
    || !record(value.modelAliases) || !record(value.roles) || !Array.isArray(value.allowedModels)
    || Object.keys(value).some(key => !['version', 'root', 'modelAliases', 'roles', 'allowedModels', 'defaultEffort', 'sessionHook'].includes(key))) {
    throw new Error('invalid pstack config: expected version 1, optional absolute root, modelAliases, roles, and allowedModels')
  }
  const modelAliases: Record<string, RouteConfig> = {}
  for (const [alias, route] of Object.entries(value.modelAliases)) {
    if (!isModelAlias(alias)
      || !record(route) || !identifier(route.provider) || !identifier(route.model)
      || (route.reasoningEffort !== undefined && (!identifier(route.reasoningEffort) || /\s/.test(route.reasoningEffort)))
      || Object.keys(route).some(key => !['provider', 'model', 'reasoningEffort'].includes(key))) {
      throw new Error(`invalid pstack model alias: ${alias}`)
    }
    modelAliases[alias] = { provider: route.provider, model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort } }
  }
  const roles: Record<string, string> = {}
  for (const [role, choice] of Object.entries(value.roles)) {
    if (!isPstackRole(role) || !identifier(choice)) {
      throw new Error(`invalid pstack role: ${role}`)
    }
    for (const entry of choice.split(',')) {
      const [alias, effort, extra] = entry.trim().split('@').map(part => part.trim())
      if (alias === undefined || !['auto', 'inherit-parent', ...Object.keys(modelAliases)].includes(alias)
        || extra !== undefined || (effort !== undefined && (!identifier(effort) || /\s/.test(effort)))) {
        throw new Error(`invalid pstack role choice: ${role} = ${choice}`)
      }
    }
    roles[role] = choice
  }
  const allowedModels: PstackPreferences['allowedModels'] = []
  for (const route of value.allowedModels) {
    if (!record(route) || !identifier(route.provider) || !identifier(route.model)
      || Object.keys(route).some(key => !['provider', 'model'].includes(key))
      || allowedModels.some(other => other.provider === route.provider && other.model === route.model)) {
      throw new Error('invalid pstack allowedModels route')
    }
    allowedModels.push({ provider: route.provider, model: route.model })
  }
  if (value.defaultEffort !== undefined && (!identifier(value.defaultEffort) || /\s/.test(value.defaultEffort))) throw new Error('invalid pstack defaultEffort')
  if (value.sessionHook !== undefined && typeof value.sessionHook !== 'boolean') throw new Error('invalid pstack sessionHook')
  return { version: 1, ...value.root === undefined ? {} : { root: value.root }, modelAliases, roles, allowedModels,
    ...value.defaultEffort === undefined ? {} : { defaultEffort: value.defaultEffort },
    ...value.sessionHook === undefined ? {} : { sessionHook: value.sessionHook } }
}

/** Define inherited model choices for the shipped pstack roles.
 * @returns all shipped role choices without unavailable vendor defaults.
 */
export function defaultPstackRoles(): Record<string, string> {
  return Object.fromEntries([
    'feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'judgment and prose',
    'strongest judgment', 'how explorer', 'how explainer', 'why investigators', 'why synthesizer',
    'reflect tooling', 'reflect judgment, divergent, synthesizer', 'arena runners', 'arena cross-judge pool',
    'swarm workers', 'architect runners', 'interrogate reviewers',
  ].map(role => [role, ['arena runners', 'architect runners', 'interrogate reviewers'].includes(role)
    ? 'inherit-parent, inherit-parent, inherit-parent' : 'inherit-parent']))
}

function readPreferences(filename: string): PstackPreferences | undefined {
  try { return parsePstackPreferences(JSON.parse(readFileSync(filename, 'utf8'))) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new Error(`Cannot load ${filename}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function initialPreferences(modelAliases: Record<string, RouteConfig>): PstackPreferences {
  return { version: 1, modelAliases, roles: defaultPstackRoles(), allowedModels: [], defaultEffort: 'session', sessionHook: true }
}

function publishInitial(filename: string, initial: PstackPreferences): void {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(initial, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try { linkSync(temporary, filename) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
  } finally {
    rmSync(temporary, { force: true })
  }
}

/** Load preferences, publishing safe bundled defaults only when the file is absent.
 * Concurrent initializers publish a complete file without replacing another writer's config.
 * @returns persisted preferences; malformed or unreadable files fail without modification.
 */
export function loadPstackPreferences(): PstackPreferences {
  const filename = pstackConfigPath()
  const existing = readPreferences(filename)
  if (existing !== undefined) return existing
  publishInitial(filename, initialPreferences({}))
  const winner = readPreferences(filename)
  if (winner === undefined) throw new Error(`Cannot load ${filename}: config removed during initialization`)
  return winner
}

type ExactRoute = Readonly<Pick<RouteConfig, 'provider' | 'model'>>

/** Initialize an absent home from the host catalog without granting any route.
 * @param catalog - catalog discovery outside the file writer lock; failures leave the home absent.
 * @param profileAliases - names reserved by the caller's profile overrides.
 * @returns when complete preferences exist; an existing file always wins unchanged.
 */
export async function initializePstackPreferences(
  catalog: () => Promise<readonly ExactRoute[]>, profileAliases: Readonly<Record<string, RouteConfig>>,
): Promise<void> {
  const filename = pstackConfigPath()
  if (readPreferences(filename) !== undefined) return
  const routes = [...new Map((await catalog()).map(route => [JSON.stringify([route.provider, route.model]), route])).entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const counts = new Map<string, number>()
  for (const [, route] of routes) counts.set(route.model, (counts.get(route.model) ?? 0) + 1)
  const reserved = new Set(Object.keys(profileAliases))
  const aliases: Record<string, RouteConfig> = {}
  for (const [, route] of routes) {
    if (isModelAlias(route.model) && counts.get(route.model) === 1 && !reserved.has(route.model)) {
      aliases[route.model] = { ...route }
      reserved.add(route.model)
    }
  }
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32) || 'route'
  for (const [identity, route] of routes) {
    if (aliases[route.model]?.provider === route.provider && aliases[route.model]?.model === route.model) continue
    const digest = createHash('sha256').update(identity).digest('hex')
    const prefix = `catalog_${slug(route.provider)}_${slug(route.model)}_`
    let alias = `${prefix}${digest.slice(0, 12)}`
    if (reserved.has(alias)) alias = `${prefix}${digest}`
    if (reserved.has(alias)) throw new Error(`pstack catalog alias collision: ${alias}`)
    aliases[alias] = { ...route }
    reserved.add(alias)
  }
  const initial = parsePstackPreferences(initialPreferences(aliases))
  publishInitial(filename, initial)
  if (readPreferences(filename) === undefined) throw new Error(`Cannot load ${filename}: config removed during initialization`)
}

interface SetupPatch {
  readonly modelAliases: Readonly<Record<string, RouteConfig>>
  readonly roles: Readonly<Record<string, string>>
  readonly removeModelAliases: readonly string[]
  readonly defaultEffort?: string
  readonly sessionHook?: boolean
}

function parseSetupPatch(value: unknown): SetupPatch {
  if (!record(value) || Object.keys(value).some(key => !['modelAliases', 'removeModelAliases', 'roles', 'defaultEffort', 'sessionHook'].includes(key))) {
    throw new Error('setup accepts only modelAliases, removeModelAliases, roles, defaultEffort, sessionHook; route authorization is operator-owned')
  }
  if ((value.modelAliases !== undefined && !record(value.modelAliases)) || (value.roles !== undefined && !record(value.roles))) throw new Error('modelAliases and roles must be objects')
  const removed = value.removeModelAliases ?? []
  if (!Array.isArray(removed)) throw new Error('removeModelAliases must contain distinct valid alias names')
  const removeModelAliases: string[] = []
  for (const alias of removed) {
    if (typeof alias !== 'string' || !isModelAlias(alias) || removeModelAliases.includes(alias)) {
      throw new Error('removeModelAliases must contain distinct valid alias names')
    }
    removeModelAliases.push(alias)
  }
  const aliases = parsePstackPreferences({ version: 1, modelAliases: value.modelAliases ?? {}, roles: {}, allowedModels: [],
    ...value.defaultEffort === undefined ? {} : { defaultEffort: value.defaultEffort },
    ...value.sessionHook === undefined ? {} : { sessionHook: value.sessionHook } })
  if (removeModelAliases.some(alias => Object.hasOwn(aliases.modelAliases, alias))) throw new Error('cannot upsert and remove the same model alias')
  const roles = value.roles ?? {}
  if (!record(roles) || Object.entries(roles).some(([role, choice]) => !isPstackRole(role) || !identifier(choice))) throw new Error('invalid pstack roles')
  return Object.freeze({
    modelAliases: Object.freeze(Object.fromEntries(Object.entries(aliases.modelAliases)
      .map(([alias, route]) => [alias, Object.freeze(route)]))),
    roles: Object.freeze(Object.fromEntries(Object.entries(roles).map(([role, choice]) => [role, String(choice)]))),
    removeModelAliases: Object.freeze(removeModelAliases),
    ...aliases.defaultEffort === undefined ? {} : { defaultEffort: aliases.defaultEffort },
    ...aliases.sessionHook === undefined ? {} : { sessionHook: aliases.sessionHook } })
}

function mergePatch(current: PstackPreferences, patch: SetupPatch): PstackPreferences {
  const modelAliases = Object.fromEntries(Object.entries({ ...current.modelAliases, ...patch.modelAliases })
    .filter(([alias]) => !patch.removeModelAliases.includes(alias)))
  return parsePstackPreferences({ ...current, modelAliases, roles: { ...current.roles, ...patch.roles },
    ...patch.defaultEffort === undefined ? {} : { defaultEffort: patch.defaultEffort },
    ...patch.sessionHook === undefined ? {} : { sessionHook: patch.sessionHook } })
}

function revision(value: PstackPreferences): string {
  return JSON.stringify(value, (_key, item: unknown) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
}

/** A validated setup edit bound to one file snapshot and exact route selection. */
export interface PreparedPstackUpdate {
  readonly effectiveAliases: Readonly<Record<string, Readonly<RouteConfig>>>
  readonly effectiveRoles: Readonly<Record<string, string>>
  readonly aliasUpserts: readonly Readonly<RouteConfig>[]
  readonly defaultEffort: string | undefined
  readonly selectedRoutes: readonly ExactRoute[]
  readonly unsavedRoutes: readonly ExactRoute[]
  /** Commit this edit or reject a stale snapshot before the caller grants Session routes. */
  readonly persist: (approval: HumanApproval | undefined) => Promise<string>
}

/** Prepare a detached setup edit before live validation or human confirmation.
 * @param value - untrusted model JSON with alias, role, deletion, or control edits.
 * @param profileAliases - effective profile overrides, never copied into saved aliases.
 * @returns immutable validation fields and a snapshot-bound commit operation.
 */
export function preparePstackUpdate(value: unknown, profileAliases: Readonly<Record<string, RouteConfig>>): PreparedPstackUpdate {
  const filename = pstackConfigPath()
  const current = loadPstackPreferences()
  const original = revision(current)
  const patch = parseSetupPatch(value)
  const next = mergePatch(current, patch)
  const effectiveAliases = Object.freeze(Object.fromEntries(Object.entries({ ...next.modelAliases, ...profileAliases })
    .map(([alias, route]) => [alias, Object.freeze({ ...route })])))
  const selected = new Map<string, ExactRoute>()
  const names = [...Object.keys(patch.modelAliases), ...Object.values(patch.roles)
    .flatMap(choice => choice.split(',').map(entry => entry.split('@').at(0)?.trim() ?? ''))]
  for (const alias of names) {
    if (alias === 'auto' || alias === 'inherit-parent') continue
    const route = effectiveAliases[alias]
    if (route !== undefined) {
      selected.set(JSON.stringify([route.provider, route.model]), Object.freeze({ provider: route.provider, model: route.model }))
    }
  }
  const selectedRoutes = Object.freeze([...selected.values()])
  const unsavedRoutes = Object.freeze(selectedRoutes.filter(route => !current.allowedModels
    .some(saved => saved.provider === route.provider && saved.model === route.model)))
  return Object.freeze({ effectiveAliases, effectiveRoles: Object.freeze({ ...defaultPstackRoles(), ...next.roles }),
    defaultEffort: next.defaultEffort,
    aliasUpserts: Object.freeze(Object.entries(effectiveAliases).filter(([alias]) => Object.hasOwn(patch.modelAliases, alias))
      .map(([, route]) => route)), selectedRoutes, unsavedRoutes,
    persist: async (approval: HumanApproval | undefined) => withFileLock(filename, async () => {
      const latest = readPreferences(filename)
      if (latest === undefined || revision(latest) !== original) throw new Error('Pstack preferences changed during setup; discover models and repeat setup with fresh confirmation')
      const merged = mergePatch(latest, patch)
      if (approval !== undefined) assertHumanApproval(approval)
      for (const route of approval?.routes ?? []) {
        if (!selected.has(JSON.stringify([route.provider, route.model]))) throw new Error('human approval includes a route not selected by this setup')
        if (!merged.allowedModels.some(saved => saved.provider === route.provider && saved.model === route.model)) {
          merged.allowedModels.push({ provider: route.provider, model: route.model })
        }
      }
      await writeFileAtomic(filename, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
      return filename
    }),
  })
}

/** Save an edit under the home writer lock, rejecting concurrent changes.
 * @param value - alias, role, deletion, or control edits; authorization fields are refused.
 * @param grant - genuine human approval for selected routes; omission preserves existing grants.
 * @returns committed filename; a stale snapshot rejects without writing.
 */
export async function savePstackPreferences(value: unknown, grant?: HumanApproval): Promise<string> {
  return preparePstackUpdate(value, {}).persist(grant)
}
