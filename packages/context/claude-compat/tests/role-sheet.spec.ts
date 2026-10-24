import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadRoleSheet, parseRoleSheetFile, renderRoleSheet } from '../src/role-sheet.ts'
import { savePstackPreferences } from '../src/pstack-config.ts'

const aliases = { fast: { provider: 'alpha', model: 'fast', reasoningEffort: 'low' }, deep: { provider: 'beta', model: 'big' } }
const input = { choices: { roles: { 'bug-fix': 'deep' }, defaultEffort: 'session' }, aliases, source: '$DSH_HOME/pstack/config.json', unconfiguredHint: false }

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
    ['a role', { choices: { roles: { 'bug-fix': 'fast' }, defaultEffort: 'session' } }],
    ['an alias', { aliases: { ...aliases, extra: { provider: 'gamma', model: 'x' } } }],
    ['the default effort', { choices: { roles: { 'bug-fix': 'deep' }, defaultEffort: 'high' } }],
  ])('changes its digest when %s changes', (_name, change) => {
    expect(renderRoleSheet({ ...input, ...change }).digest).not.toBe(renderRoleSheet(input).digest)
  })
  it('adds the setup hint only for an unconfigured installation', () => {
    expect(renderRoleSheet({ ...input, aliases: {}, unconfiguredHint: true }).text).toContain('Pstack models are not configured')
    expect(renderRoleSheet({ ...input, aliases: {}, unconfiguredHint: true }).text).toContain('Configured model aliases: (none).')
    expect(renderRoleSheet(input).text).not.toContain('not configured')
  })
})

describe('role choices', () => {
  let home = ''
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'role-sheet-'))
    vi.stubEnv('DSH_HOME', join(home, 'dsh'))
    vi.stubEnv('DSH_AGENTS_HOME', join(home, 'shared'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('parses a saved sheet, dropping the session hook line and splitting roles from the default effort', () => {
    expect(parseRoleSheetFile('session hook: off\nbug-fix: opus\narena runners: a, b @high\ndefault effort: high\nnot a line')).toEqual({
      hookOff: true,
      choices: { roles: { 'bug-fix': 'opus', 'arena runners': 'a, b @high' }, defaultEffort: 'high' },
    })
  })
  it('loads preferences with shipped defaults for unsaved roles', () => {
    savePstackPreferences({ modelAliases: { deep: { provider: 'beta', model: 'big' } }, roles: { 'bug-fix': 'deep' }, sessionHook: false })
    const loaded = loadRoleSheet(undefined)
    expect(loaded.hookOff).toBe(true)
    expect(loaded.source).toBe('$DSH_HOME/pstack/config.json')
    expect(loaded.choices.roles['bug-fix']).toBe('deep')
    expect(loaded.choices.roles['perf-issue']).toBe('inherit-parent')
    expect(loaded.choices.defaultEffort).toBe('session')
  })
  it('loads a sheet file, including a UTF-16 one, and shows its quoted path as the source', () => {
    const file = join(home, 'sheet.md')
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('bug-fix: deep\r\ndefault effort: low\r\n', 'utf16le')]))
    const loaded = loadRoleSheet(file)
    expect(loaded.choices).toEqual({ roles: { 'bug-fix': 'deep' }, defaultEffort: 'low' })
    expect(loaded.source).toBe(JSON.stringify(file))
  })
})
