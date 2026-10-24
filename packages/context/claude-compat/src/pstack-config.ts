/** Home-scoped pstack preferences; route authorization remains host-owned. */
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
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
    if (!/^[a-zA-Z0-9_-]+$/.test(alias) || ['auto', 'inherit-parent', '__proto__', 'constructor', 'prototype'].includes(alias)
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
    if (!/^[a-z][a-z ,_-]*$/.test(role) || ['session hook', 'constructor', 'prototype'].includes(role) || !identifier(choice)) {
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

/** Load preferences, publishing safe bundled defaults only when the file is absent.
 * Concurrent initializers publish a complete file without replacing another writer's config.
 * @returns persisted preferences; malformed or unreadable files fail without modification.
 */
export function loadPstackPreferences(): PstackPreferences {
  const filename = pstackConfigPath()
  const read = () => parsePstackPreferences(JSON.parse(readFileSync(filename, 'utf8')))
  try { return read() }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new Error(`Cannot load ${filename}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  const initial: PstackPreferences = { version: 1, modelAliases: {},
    roles: defaultPstackRoles(), allowedModels: [], defaultEffort: 'session', sessionHook: true }
  mkdirSync(dirname(filename), { recursive: true })
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
  try { return read() }
  catch (error) { throw new Error(`Cannot load ${filename}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
}

/**
 * Reject a setup update that touches anything but aliases, roles, and the two controls.
 * Route authorization is not model-editable, so `allowedModels` is refused here, before any question is asked.
 * @param value - parsed JSON the model supplied.
 * @throws when the update is not an object, carries other keys, or has non-object aliases or roles.
 */
export function assertSetupUpdate(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !['modelAliases', 'roles', 'defaultEffort', 'sessionHook'].includes(key))) {
    throw new Error('setup accepts only modelAliases, roles, defaultEffort, sessionHook; route authorization is operator-owned')
  }
  if ((value.modelAliases !== undefined && !record(value.modelAliases)) || (value.roles !== undefined && !record(value.roles))) throw new Error('modelAliases and roles must be objects')
}

/** Atomically save validated preferences. Routes are added to `allowedModels` only with a person's confirmation.
 * @param value - preferences containing aliases and role choices.
 * @param grant - proof that a person confirmed routes in this call; its routes join the saved `allowedModels`.
 * @returns committed preferences filename.
 */
export function savePstackPreferences(value: unknown, grant?: HumanApproval): string {
  const current = loadPstackPreferences()
  assertSetupUpdate(value)
  const added = (grant?.routes ?? []).filter(route => !current.allowedModels.some(
    saved => saved.provider === route.provider && saved.model === route.model))
  const next = parsePstackPreferences({ ...current, ...value,
    modelAliases: { ...current.modelAliases, ...record(value.modelAliases) ? value.modelAliases : {} },
    roles: { ...current.roles, ...record(value.roles) ? value.roles : {} },
    allowedModels: [...current.allowedModels, ...added.map(route => ({ provider: route.provider, model: route.model }))] })
  const filename = pstackConfigPath()
  mkdirSync(dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, filename)
  } finally {
    rmSync(temporary, { force: true })
  }
  return filename
}
