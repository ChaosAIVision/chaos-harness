import { describe, expect, it } from 'vitest'
import { parseRoleLines, preferenceRoleLines, renderRoleSheet, splitRoleLines } from '../src/role-sheet.ts'
import type { PstackPreferences } from '../src/pstack-config.ts'

const aliases = { fast: { provider: 'alpha', model: 'fast', reasoningEffort: 'low' }, deep: { provider: 'beta', model: 'big' } }
const input = { lines: ['bug-fix: deep', 'default effort: session'], aliases, source: '$DSH_HOME/pstack/config.json', unconfiguredHint: false }

describe('renderRoleSheet', () => {
  it('is pure and starts with a digest header that supersedes earlier sheets', () => {
    const first = renderRoleSheet(input)
    expect(renderRoleSheet(input)).toEqual(first)
    expect(first.digest).toMatch(/^[0-9a-f]{8}$/)
    expect(first.text.startsWith(`pstack role sheet ${first.digest}. This supersedes every earlier role sheet and alias list in this conversation.`)).toBe(true)
    expect(first.text).toContain('fast => alpha/fast @low, deep => beta/big')
    expect(first.text).toContain('bug-fix: deep')
  })
  it.each([
    ['a role', { lines: ['bug-fix: fast', 'default effort: session'] }],
    ['an alias', { aliases: { ...aliases, extra: { provider: 'gamma', model: 'x' } } }],
    ['the default effort', { lines: ['bug-fix: deep', 'default effort: high'] }],
  ])('changes its digest when %s changes', (_name, change) => {
    expect(renderRoleSheet({ ...input, ...change }).digest).not.toBe(renderRoleSheet(input).digest)
  })
  it('adds the setup hint only for an unconfigured installation', () => {
    expect(renderRoleSheet({ ...input, aliases: {}, unconfiguredHint: true }).text).toContain('Pstack models are not configured')
    expect(renderRoleSheet({ ...input, aliases: {}, unconfiguredHint: true }).text).toContain('Configured model aliases: (none).')
    expect(renderRoleSheet(input).text).not.toContain('not configured')
  })
})

describe('role lines', () => {
  it('parses a saved sheet, dropping the session hook line', () => {
    expect(parseRoleLines('session hook: off\nbug-fix: opus\ndefault effort: high\nnot a line')).toEqual({
      sessionHookOff: true, lines: ['bug-fix: opus', 'default effort: high'],
    })
  })
  it('derives lines from preferences with shipped defaults for unsaved roles', () => {
    const preferences: PstackPreferences = { version: 1, modelAliases: {}, roles: { 'bug-fix': 'deep' }, allowedModels: [], sessionHook: false }
    const { lines, sessionHookOff } = preferenceRoleLines(preferences)
    expect(sessionHookOff).toBe(true)
    expect(lines).toContain('bug-fix: deep')
    expect(lines).toContain('perf-issue: inherit-parent')
    expect(lines.at(-1)).toBe('default effort: session')
  })
  it('splits lines into roles and the default effort', () => {
    expect(splitRoleLines(['bug-fix: deep', 'arena runners: a, b @high', 'default effort: high'])).toEqual({
      roles: { 'bug-fix': 'deep', 'arena runners': 'a, b @high' }, defaultEffort: 'high',
    })
  })
})
