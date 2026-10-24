import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundledPstackRoot, install, loadPstackPreferences, parsePstackPreferences, pstackConfigPath, savePstackPreferences } from '../src/index.ts'
import type { CompatHost } from '../src/index.ts'
import { mintHumanApproval } from '@deepseek-ai/dsh-tool-subagent'
import type { HumanApproval } from '@deepseek-ai/dsh-tool-subagent'

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
  persist({ ...loadPstackPreferences(), root })
}
function persist(value: unknown) {
  mkdirSync(join(home, 'dsh', 'pstack'), { recursive: true })
  writeFileSync(pstackConfigPath(), JSON.stringify(value))
}

describe('home-scoped pstack preferences', () => {
  it('publishes portable bundled defaults in a cold home without shared installation', () => {
    const preferences = loadPstackPreferences()
    expect(preferences.root).toBeUndefined()
    expect(JSON.parse(readFileSync(pstackConfigPath(), 'utf8'))).toEqual(preferences)
    expect(bundledPstackRoot()).toBe(fileURLToPath(new URL('../resources/pstack/', import.meta.url)))
    expect(readdirSync(join(home, 'dsh', 'pstack'))).toEqual(['config.json'])
    expect(loadPstackPreferences()).toEqual(preferences)
  })
  it('never replaces an existing external root or grants during initialization', () => {
    const existing = { ...loadPstackPreferences(), root: '/external/pstack', allowedModels: [{ provider: 'chosen', model: 'exact' }] }
    persist(existing)
    const bytes = readFileSync(pstackConfigPath(), 'utf8')
    expect(loadPstackPreferences()).toEqual(existing)
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(bytes)
  })
  it('publishes complete defaults under concurrent cold-home initialization', async () => {
    const module = new URL('../src/pstack-config.ts', import.meta.url).href
    const script = `import { loadPstackPreferences } from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(loadPstackPreferences()))`
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], { env: process.env })
      let output = ''
      let errors = ''
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      child.stderr.on('data', (chunk) => { errors += String(chunk) })
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve(output)
        else reject(new Error(errors))
      })
    })))
    expect(new Set(results).size).toBe(1)
    expect(JSON.parse(results[0]!)).toEqual(loadPstackPreferences())
    expect(readdirSync(join(home, 'dsh', 'pstack'))).toEqual(['config.json'])
  })
  it('initializes all 17 roles without unavailable vendor defaults', () => {
    installed()
    const preferences = loadPstackPreferences()
    expect(Object.keys(preferences.roles)).toHaveLength(17)
    expect(preferences.roles['arena runners']).toBe('inherit-parent, inherit-parent, inherit-parent')
    expect(preferences.allowedModels).toEqual([])
    expect(preferences.modelAliases).toEqual({})
  })
  it('accepts actual compound role keys, panel multiplicity, and spaced efforts', () => {
    installed()
    const base = loadPstackPreferences()
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
    const preferences = { ...loadPstackPreferences(), allowedModels: [{ provider: 'test', model: 'judge' }] }
    persist(preferences)
    savePstackPreferences({ roles: { 'feature, refactoring': 'inherit-parent' } })
    expect(loadPstackPreferences().allowedModels).toEqual(preferences.allowedModels)
    const before = readFileSync(pstackConfigPath(), 'utf8')
    expect(() => savePstackPreferences({ allowedModels: [{ provider: 'evil', model: 'other' }] })).toThrow('operator-owned')
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
  })
  it('adds routes to allowedModels only with a human approval proof, without duplicates', () => {
    installed()
    persist({ ...loadPstackPreferences(), allowedModels: [{ provider: 'test', model: 'judge' }] })
    savePstackPreferences({ roles: {} }, mintHumanApproval([{ provider: 'test', model: 'judge' }, { provider: 'test', model: 'fast' }]))
    expect(loadPstackPreferences().allowedModels).toEqual([{ provider: 'test', model: 'judge' }, { provider: 'test', model: 'fast' }])
  })
  it('cannot be handed a forged approval at compile time', () => {
    const forge = () => {
      // @ts-expect-error an object literal is not a HumanApproval; only mintHumanApproval constructs one
      savePstackPreferences({ roles: {} }, { routes: [{ provider: 'evil', model: 'other' }] })
    }
    expect(forge).toBeTypeOf('function')
  })
  it('rejects a structurally forged approval at runtime and writes nothing', () => {
    installed()
    const before = readFileSync(pstackConfigPath(), 'utf8')
    const forged = { routes: [{ provider: 'evil', model: 'other' }] } as unknown as HumanApproval
    expect(() => savePstackPreferences({ roles: {} }, forged)).toThrow('human approval')
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
  })
  it('loads the same native mandate and role sheet for unrelated working directories', () => {
    installed()
    const contexts: Array<(child: boolean) => string | undefined> = []
    const host: CompatHost = { registerTool: () => () => {}, startActivation: async () => ({ childId: 'child', result: Promise.resolve(undefined) }),
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
