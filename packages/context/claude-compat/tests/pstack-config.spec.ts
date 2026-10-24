import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { install, loadPstackPreferences, parsePstackPreferences, pstackConfigPath, savePstackPreferences } from '../src/index.ts'
import type { CompatHost } from '../src/index.ts'

let home = ''
let root = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pstack-home-'))
  root = join(home, 'shared', 'pstack-plugin')
  vi.stubEnv('DSH_HOME', join(home, 'dsh'))
  vi.stubEnv('DSH_AGENTS_HOME', join(home, 'shared'))
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })
function installed() {
  mkdirSync(join(root, 'hooks'), { recursive: true })
  writeFileSync(join(root, 'hooks', 'session-start-context.md'), 'PSTACK MANDATE')
}
function persist(value: unknown) {
  mkdirSync(join(home, 'dsh', 'pstack'), { recursive: true })
  writeFileSync(pstackConfigPath(), JSON.stringify(value))
}

describe('home-scoped pstack preferences', () => {
  it('is inert without an installation or preferences', () => {
    expect(loadPstackPreferences()).toBeUndefined()
  })
  it('initializes all 17 roles without unavailable vendor defaults', () => {
    installed()
    const preferences = loadPstackPreferences()!
    expect(Object.keys(preferences.roles)).toHaveLength(17)
    expect(preferences.roles['arena runners']).toBe('inherit-parent, inherit-parent, inherit-parent')
    expect(preferences.allowedModels).toEqual([])
    expect(preferences.modelAliases).toEqual({})
  })
  it('accepts actual compound role keys, panel multiplicity, and spaced efforts', () => {
    installed()
    const base = loadPstackPreferences()!
    const preferences = parsePstackPreferences({ ...base,
      modelAliases: { strong: { provider: 'test', model: 'judge' } },
      roles: { ...base.roles, 'feature, refactoring': 'strong @high',
        'reflect judgment, divergent, synthesizer': 'strong', 'arena runners': 'strong @high, inherit-parent, strong' },
      defaultEffort: 'session', sessionHook: false,
    })
    expect(preferences.roles['arena runners']).toBe('strong @high, inherit-parent, strong')
  })
  it.each([{}, { version: 2 }, { version: 1, root: 'relative', modelAliases: {}, roles: {}, allowedModels: [] }])('rejects malformed persisted preferences', (value) => {
    persist(value)
    expect(() => loadPstackPreferences()).toThrow('Cannot load')
  })
  it('rejects truncated JSON rather than silently inheriting', () => {
    persist({})
    writeFileSync(pstackConfigPath(), '{')
    expect(() => loadPstackPreferences()).toThrow('Cannot load')
  })
  it('saves atomically, preserving operator authorizations and rejecting escalation', () => {
    installed()
    const preferences = { ...loadPstackPreferences()!, allowedModels: [{ provider: 'test', model: 'judge' }] }
    persist(preferences)
    savePstackPreferences({ roles: { 'feature, refactoring': 'inherit-parent' } })
    expect(loadPstackPreferences()?.allowedModels).toEqual(preferences.allowedModels)
    const before = readFileSync(pstackConfigPath(), 'utf8')
    expect(() => savePstackPreferences({ allowedModels: [{ provider: 'evil', model: 'other' }] })).toThrow('operator-owned')
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
  })
  it('loads the same native mandate and role sheet for unrelated working directories', () => {
    installed()
    const contexts: Array<(child: boolean) => string | undefined> = []
    const host: CompatHost = { registerTool: () => () => {}, startActivation: async () => ({ childId: 'child' }),
      llm: undefined, mountHooks: () => {}, onAgentCreated: (context) => { contexts.push(context) } }
    for (const cwd of ['/unrelated/repo-a', '/another/repo-b']) {
      const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd)
      try { install(host, { roots: [], models: {}, modelAliases: {}, provider: 'spawn', hooks: false, modelSelection: false }) }
      finally { spy.mockRestore() }
    }
    expect(contexts[0]?.(false)).toContain('PSTACK MANDATE')
    expect(contexts[0]?.(false)).toBe(contexts[1]?.(false))
    expect(contexts[0]?.(true)).not.toContain('PSTACK MANDATE')
    expect(contexts[0]?.(false)).toContain('feature, refactoring: inherit-parent')
  })
})
