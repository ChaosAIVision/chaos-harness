/** The model-facing pstack role sheet: one renderer for initialization and for mid-session refreshes. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { RouteConfig } from './index.ts'
import { defaultPstackRoles, isPstackRole, loadPstackPreferences } from './pstack-config.ts'

/** A rendered sheet and the digest a model can compare against `claude_agent_models`. */
export interface RoleSheet {
  /** Complete sheet text, starting with the digest header. */
  readonly text: string
  /** First 8 hex characters of the SHA-256 of the sheet body; identical content gives an identical digest. */
  readonly digest: string
}

/** Saved role choices as data; text appears only when a sheet is rendered. */
export interface RoleChoices {
  /** Role name to alias or comma-separated `alias@effort` entries. */
  readonly roles: Readonly<Record<string, string>>
  /** Effort applied to entries without a suffix; absent when the saved sheet states none. */
  readonly defaultEffort: string | undefined
}

/** Role choices with where they came from. */
export interface LoadedRoleSheet {
  readonly choices: RoleChoices
  /** Whether `session hook: off` is saved. */
  readonly hookOff: boolean
  /** Where the saved choices live, shown to the model. */
  readonly source: string
}

/** Everything one sheet depends on. */
export interface RoleSheetInput {
  readonly choices: RoleChoices
  /** Aliases in force when the sheet is rendered. */
  readonly aliases: Readonly<Record<string, RouteConfig>>
  /** Where the saved choices live, shown to the model. */
  readonly source: string
  /** Whether to tell the model that no aliases are configured and setup is needed. */
  readonly unconfiguredHint: boolean
}

/**
 * Parse a saved sheet file into role choices and the session-hook switch.
 * @param sheet - text with one `role: choice` pair per line.
 * @returns role choices, the default effort when stated, and whether `session hook: off` is present.
 */
export function parseRoleSheetFile(sheet: string): { choices: RoleChoices; hookOff: boolean } {
  const lines = sheet.split('\n')
  const roles: Record<string, string> = {}
  let defaultEffort: string | undefined
  for (const line of lines) {
    const at = line.indexOf(': ')
    if (at < 0 || !isPstackRole(line.slice(0, at)) || line.slice(at + 2).length === 0) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 2)
    if (key === 'default effort') defaultEffort = value
    else roles[key] = value
  }
  return { choices: { roles, defaultEffort }, hookOff: lines.includes('session hook: off') }
}

/**
 * Load the saved role choices from home-scoped preferences, or from a sheet file when one is configured.
 * Preferences fill roles the user never saved with shipped defaults.
 * @param sheetPath - absolute sheet file; undefined reads the preferences.
 * @returns the choices, the hook switch, and the display source.
 */
export function loadRoleSheet(sheetPath: string | undefined): LoadedRoleSheet {
  if (sheetPath === undefined) {
    const preferences = loadPstackPreferences()
    return {
      choices: { roles: { ...defaultPstackRoles(), ...preferences.roles }, defaultEffort: preferences.defaultEffort ?? 'session' },
      hookOff: preferences.sessionHook === false,
      source: '$DSH_HOME/pstack/config.json',
    }
  }
  const bytes = readFileSync(sheetPath)
  const text = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  return { ...parseRoleSheetFile(text), source: JSON.stringify(sheetPath) }
}

/**
 * Render the sheet. Pure: the same input always yields the same text and digest.
 * @param input - role choices, aliases, and display source.
 * @returns the sheet text and its digest.
 */
export function renderRoleSheet(input: RoleSheetInput): RoleSheet {
  const aliasCatalog = Object.entries(input.aliases).map(([alias, route]) =>
    `${alias} => ${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` @${route.reasoningEffort}`}`,
  ).join(', ') || '(none)'
  const body = [
    `Configured model aliases: ${aliasCatalog}.`,
    `Saved pstack model choices (${input.source}); use these role choices with claude_agent:`,
    ...Object.entries(input.choices.roles).map(([role, choice]) => `${role}: ${choice}`),
    ...input.choices.defaultEffort === undefined ? [] : [`default effort: ${input.choices.defaultEffort}`],
    input.unconfiguredHint
      ? 'Pstack models are not configured. Ask the user which models to use via setup-pstack; discover models with claude_agent_models and save with claude_agent_setup. Until configured, inherit the parent route; never invent aliases.'
      : '',
  ].join('\n\n')
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 8)
  return {
    digest,
    text: `pstack role sheet ${digest}. This supersedes every earlier role sheet and alias list in this conversation.\n\n${body}`,
  }
}

/**
 * Wrap text as the context message the Claude hook bridge injects.
 * @param text - model-facing context.
 * @returns a user message attributed to the Claude hook bridge.
 */
export function contextMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'hooks-claude-code' } })
}
