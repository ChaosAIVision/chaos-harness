/** The model-facing pstack role sheet: one renderer for initialization and for mid-session refreshes. */
import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { RouteConfig } from './index.ts'
import { defaultPstackRoles } from './pstack-config.ts'
import type { PstackPreferences } from './pstack-config.ts'

/** A rendered sheet and the digest a model can compare against `claude_agent_models`. */
export interface RoleSheet {
  /** Complete sheet text, starting with the digest header. */
  readonly text: string
  /** First 8 hex characters of the SHA-256 of the sheet body; identical content gives an identical digest. */
  readonly digest: string
}

/** Everything one sheet depends on. */
export interface RoleSheetInput {
  /** `role: choice` lines, including `default effort`; never the `session hook` line. */
  readonly lines: readonly string[]
  /** Aliases in force when the sheet is rendered. */
  readonly aliases: Readonly<Record<string, RouteConfig>>
  /** Where the saved choices live, shown to the model. */
  readonly source: string
  /** Whether to tell the model that no aliases are configured and setup is needed. */
  readonly unconfiguredHint: boolean
}

/**
 * Split a saved sheet into model-facing role lines and the session-hook switch.
 * @param sheet - text with one `role: choice` pair per line.
 * @returns role and default-effort lines, and whether `session hook: off` is present.
 */
export function parseRoleLines(sheet: string): { lines: string[]; sessionHookOff: boolean } {
  const all = sheet.split('\n')
  return {
    sessionHookOff: all.includes('session hook: off'),
    lines: all.filter(line => /^[a-z][a-z ,_-]*: .+$/.test(line) && !line.startsWith('session hook:')),
  }
}

/**
 * Read role choices back out of sheet lines for structured discovery output.
 * @param lines - `role: choice` lines including `default effort`.
 * @returns role choices and the default effort, when one is stated.
 */
export function splitRoleLines(lines: readonly string[]): { roles: Record<string, string>; defaultEffort: string | undefined } {
  const roles: Record<string, string> = {}
  let defaultEffort: string | undefined
  for (const line of lines) {
    const at = line.indexOf(': ')
    const key = line.slice(0, at)
    const value = line.slice(at + 2)
    if (key === 'default effort') defaultEffort = value
    else roles[key] = value
  }
  return { roles, defaultEffort }
}

/**
 * Derive the sheet lines from saved preferences, filling roles the user never saved with shipped defaults.
 * @param preferences - validated home-scoped preferences.
 * @returns role and default-effort lines, and whether the session hook is off.
 */
export function preferenceRoleLines(preferences: PstackPreferences): { lines: string[]; sessionHookOff: boolean } {
  return {
    sessionHookOff: preferences.sessionHook === false,
    lines: [
      ...Object.entries({ ...defaultPstackRoles(), ...preferences.roles }).map(([role, choice]) => `${role}: ${choice}`),
      `default effort: ${preferences.defaultEffort ?? 'session'}`,
    ],
  }
}

/**
 * Render the sheet. Pure: the same input always yields the same text and digest.
 * @param input - role lines, aliases, and display source.
 * @returns the sheet text and its digest.
 */
export function renderRoleSheet(input: RoleSheetInput): RoleSheet {
  const aliasCatalog = Object.entries(input.aliases).map(([alias, route]) =>
    `${alias} => ${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` @${route.reasoningEffort}`}`,
  ).join(', ') || '(none)'
  const body = [
    `Configured model aliases: ${aliasCatalog}.`,
    `Saved pstack model choices (${input.source}); use these role choices with claude_agent:`,
    ...input.lines,
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
