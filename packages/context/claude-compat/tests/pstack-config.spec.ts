import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundledPstackRoot, install, loadPstackPreferences, parsePstackPreferences, pstackConfigPath, savePstackPreferences } from '../src/index.ts'
import type { CompatHost } from '../src/index.ts'
import { mintHumanApproval } from '@deepseek-ai/dsh-tool-subagent'
import { initializePstackPreferences, preparePstackUpdate } from '../src/pstack-config.ts'
import { configProcess } from './pstack-process.ts'
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
  it('saves atomically, preserving operator authorizations and rejecting escalation', async () => {
    installed()
    const preferences = { ...loadPstackPreferences(), allowedModels: [{ provider: 'test', model: 'judge' }] }
    persist(preferences)
    await savePstackPreferences({ roles: { 'feature, refactoring': 'inherit-parent' } })
    expect(loadPstackPreferences().allowedModels).toEqual(preferences.allowedModels)
    const before = readFileSync(pstackConfigPath(), 'utf8')
    await expect(savePstackPreferences({ allowedModels: [{ provider: 'evil', model: 'other' }] })).rejects.toThrow('operator-owned')
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
  })
  it('adds routes to allowedModels only with a human approval proof, without duplicates', async () => {
    installed()
    persist({ ...loadPstackPreferences(), allowedModels: [{ provider: 'test', model: 'judge' }] })
    await savePstackPreferences({ modelAliases: { judge: { provider: 'test', model: 'judge' }, fast: { provider: 'test', model: 'fast' } } }, mintHumanApproval([{ provider: 'test', model: 'judge' }, { provider: 'test', model: 'fast' }]))
    expect(loadPstackPreferences().allowedModels).toEqual([{ provider: 'test', model: 'judge' }, { provider: 'test', model: 'fast' }])
  })
  it('cannot be handed a forged approval at compile time', () => {
    const forge = () => {
      // @ts-expect-error an object literal is not a HumanApproval; only mintHumanApproval constructs one
      void savePstackPreferences({ roles: {} }, { routes: [{ provider: 'evil', model: 'other' }] })
    }
    expect(forge).toBeTypeOf('function')
  })
  it('rejects a structurally forged approval at runtime and writes nothing', async () => {
    installed()
    const before = readFileSync(pstackConfigPath(), 'utf8')
    const forged = { routes: [{ provider: 'evil', model: 'other' }] } as HumanApproval
    await expect(savePstackPreferences({ roles: {} }, forged)).rejects.toThrow('human approval')
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
  })
  it('loads the same native mandate and role sheet for unrelated working directories', async () => {
    installed()
    const contexts: Array<(child: boolean) => string | undefined> = []
    const host: CompatHost = { registerTool: () => () => {}, startActivation: async () => ({ childId: 'child', result: Promise.resolve(undefined) }),
      llm: undefined, mountHooks: () => {}, onAgentCreated: (context) => { contexts.push(context) } }
    for (const cwd of ['/unrelated/repo-a', '/another/repo-b']) {
      const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd)
      try { await install(host, { roots: [], models: {}, modelAliases: {}, provider: 'spawn', hooks: false, modelSelection: false }) }
      finally { spy.mockRestore() }
    }
    expect(contexts[0]?.(false)).toContain('PSTACK MANDATE')
    expect(contexts[0]?.(false)).toBe(contexts[1]?.(false))
    expect(contexts[0]?.(true)).not.toContain('PSTACK MANDATE')
    expect(contexts[0]?.(false)).toContain('feature, refactoring: inherit-parent')
  })
})

describe('catalog initialization', () => {
  const catalog = [
    { provider: 'alpha', model: 'safe-2' }, { provider: 'alpha', model: 'shared' },
    { provider: 'beta', model: 'shared' }, { provider: 'α/β', model: 'name with/slash' },
    { provider: 'alpha', model: 'auto' }, { provider: 'alpha', model: 'occupied' },
  ]
  it('uses exact unique IDs and deterministic qualified aliases without selecting routes', async () => {
    const profile = { occupied: { provider: 'profile', model: 'override' } }
    await initializePstackPreferences(async () => [...catalog, catalog[0]!], profile)
    const first = loadPstackPreferences()
    expect(first.modelAliases['safe-2']).toEqual(catalog[0])
    expect(first.modelAliases).not.toHaveProperty('occupied')
    expect(first.modelAliases).not.toHaveProperty('shared')
    expect(first.modelAliases).not.toHaveProperty('auto')
    expect(Object.keys(first.modelAliases)).toHaveLength(catalog.length)
    expect(first.allowedModels).toEqual([])
    expect(Object.values(first.roles).every(choice => choice.split(',').every(item => item.trim() === 'inherit-parent'))).toBe(true)
    expect(statSync(pstackConfigPath()).mode & 0o777).toBe(0o600)
    rmSync(pstackConfigPath())
    await initializePstackPreferences(async () => [...catalog].reverse(), profile)
    expect(loadPstackPreferences()).toEqual(first)
  })
  it('reserves exact and profile aliases before generating fallbacks and rejects full-hash collisions', async () => {
    const route = { provider: 'alpha', model: 'auto' }
    const hash = createHash('sha256').update(JSON.stringify([route.provider, route.model])).digest('hex')
    const short = `catalog_alpha_auto_${hash.slice(0, 12)}`
    const full = `catalog_alpha_auto_${hash}`
    await initializePstackPreferences(async () => [route, { provider: 'beta', model: short }], {})
    expect(loadPstackPreferences().modelAliases[short]).toEqual({ provider: 'beta', model: short })
    expect(loadPstackPreferences().modelAliases[full]).toEqual(route)
    rmSync(pstackConfigPath())
    await initializePstackPreferences(async () => [route], { [short]: { provider: 'profile', model: 'reserved' } })
    expect(loadPstackPreferences().modelAliases[full]).toEqual(route)
    rmSync(pstackConfigPath())
    await expect(initializePstackPreferences(async () => [route], { [short]: route, [full]: route })).rejects.toThrow('catalog alias collision')
    expect(() => readFileSync(pstackConfigPath())).toThrow()
  })
  it('seeds before direct install can register tools or read context', async () => {
    const seen: Array<Record<string, { provider: string; model: string }>> = []
    const host: CompatHost = {
      registerTool: () => { seen.push(loadPstackPreferences().modelAliases); return () => {} },
      startActivation: async () => ({ childId: 'child', result: Promise.resolve(undefined) }),
      mountHooks: () => {}, onAgentCreated: () => {},
      llm: {
        listProviders: () => [{ id: 'test', name: 'Test' }],
        listModels: async () => [{ provider: 'test', id: 'catalog2', name: 'Catalog2' }],
        resolveCallConfig: async () => ({ provider: 'test', model: 'catalog2', maxTokens: 1024 }),
        resolveModelInfo: async () => ({ provider: 'test', id: 'catalog2', name: 'Catalog2' }),
      },
    }
    await install(host, { roots: [], models: {}, modelAliases: {}, provider: 'spawn', hooks: false, modelSelection: false })
    expect(seen).toHaveLength(3)
    expect(seen.every(aliases => aliases.catalog2?.model === 'catalog2')).toBe(true)
    expect(loadPstackPreferences().allowedModels).toEqual([])
  })
  it('preserves explicit bytes and deleted aliases without rediscovery', async () => {
    await initializePstackPreferences(async () => catalog, {})
    await savePstackPreferences({ removeModelAliases: ['safe-2'], sessionHook: false })
    const before = readFileSync(pstackConfigPath(), 'utf8')
    const discovery = vi.fn(async () => catalog)
    await initializePstackPreferences(discovery, {})
    expect(discovery).not.toHaveBeenCalled()
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
    expect(loadPstackPreferences().modelAliases).not.toHaveProperty('safe-2')
  })
  it('leaves an absent config absent when catalog discovery fails', async () => {
    await expect(initializePstackPreferences(async () => { throw new Error('catalog unavailable') }, {})).rejects.toThrow('catalog unavailable')
    expect(() => readFileSync(pstackConfigPath())).toThrow()
  })
  it('preserves a synchronous cold-loader winner while async discovery is pending in another process', async () => {
    const seeded = configProcess('await config.initializePstackPreferences(async () => { await waitForParent(); return [{ provider: \'alpha\', model: \'seed\' }]; }, {}); process.stdout.write(JSON.stringify(config.loadPstackPreferences()));')
    await seeded.started
    const cold = configProcess('process.stdout.write(JSON.stringify(config.loadPstackPreferences()));')
    const winner = await cold.done
    const bytes = readFileSync(pstackConfigPath(), 'utf8')
    seeded.resume()
    expect(await seeded.done).toBe(winner)
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(bytes)
    expect(loadPstackPreferences().modelAliases).toEqual({})
    expect(readdirSync(join(home, 'dsh', 'pstack'))).toEqual(['config.json'])
  })
  it('publishes one complete catalog under simultaneous process initialization', async () => {
    const children = ['first', 'second'].map(model => configProcess(`await config.initializePstackPreferences(async () => { await waitForParent(); return [{ provider: 'alpha', model: '${model}' }]; }, {}); process.stdout.write(JSON.stringify(config.loadPstackPreferences()));`))
    await Promise.all(children.map(child => child.started))
    children.forEach(child => child.resume())
    const results = await Promise.all(children.map(child => child.done))
    expect(results[0]).toBe(results[1])
    expect(Object.keys(loadPstackPreferences().modelAliases)).toHaveLength(1)
    expect(readdirSync(join(home, 'dsh', 'pstack'))).toEqual(['config.json'])
  })
})

describe('prepared setup transactions', () => {
  const route = { provider: 'test', model: 'chosen' }
  it('detaches the patch and profile overlay and captures the original filename', async () => {
    const patch = { modelAliases: { chosen: { ...route } }, roles: { review2: 'chosen' } }
    const profile = { chosen: { provider: 'profile', model: 'effective' } }
    const prepared = preparePstackUpdate(patch, profile)
    const filename = pstackConfigPath()
    patch.modelAliases.chosen.model = 'mutated'
    patch.roles.review2 = 'inherit-parent'
    profile.chosen.model = 'mutated'
    expect(prepared.selectedRoutes).toEqual([{ provider: 'profile', model: 'effective' }])
    expect(Object.isFrozen(prepared.effectiveAliases.chosen)).toBe(true)
    vi.stubEnv('DSH_HOME', join(home, 'another-home'))
    await prepared.persist(mintHumanApproval(prepared.selectedRoutes))
    const saved = parsePstackPreferences(JSON.parse(readFileSync(filename, 'utf8')))
    expect(saved.modelAliases.chosen).toEqual(route)
    expect(saved.roles.review2).toBe('chosen')
    expect(saved.allowedModels).toEqual([{ provider: 'profile', model: 'effective' }])
  })
  it('rejects proof for an unselected route and keeps the existing file', async () => {
    const prepared = preparePstackUpdate({ modelAliases: { chosen: route } }, {})
    const before = readFileSync(pstackConfigPath(), 'utf8')
    await expect(prepared.persist(mintHumanApproval([{ provider: 'test', model: 'other' }]))).rejects.toThrow('not selected')
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
  })
  it('removes unreferenced aliases, preserves historical grants, and accepts repeated removal', async () => {
    await savePstackPreferences({ modelAliases: { chosen: route }, roles: { panel2: 'chosen,inherit-parent' } }, mintHumanApproval([route]))
    expect(() => preparePstackUpdate({ removeModelAliases: ['chosen'] }, { chosen: route })).toThrow('invalid pstack role choice')
    expect(() => preparePstackUpdate({ removeModelAliases: ['chosen'], modelAliases: { chosen: route } }, {})).toThrow('upsert and remove')
    expect(() => preparePstackUpdate({ removeModelAliases: ['chosen', 'chosen'] }, {})).toThrow('distinct')
    await savePstackPreferences({ removeModelAliases: ['chosen'], roles: { panel2: 'inherit-parent,auto' } })
    await savePstackPreferences({ removeModelAliases: ['chosen'] })
    expect(loadPstackPreferences().modelAliases).toEqual({})
    expect(loadPstackPreferences().allowedModels).toEqual([route])
  })
  it('selects only explicit aliases and role entries after profile precedence', async () => {
    await savePstackPreferences({ modelAliases: { chosen: route, unused: { provider: 'test', model: 'unused' } }, roles: { other: 'unused' } })
    expect(preparePstackUpdate({ sessionHook: false }, {}).selectedRoutes).toEqual([])
    const prepared = preparePstackUpdate({ roles: { review2: 'chosen,chosen,auto' } }, { chosen: { provider: 'profile', model: 'override' } })
    expect(prepared.selectedRoutes).toEqual([{ provider: 'profile', model: 'override' }])
    expect(prepared.effectiveRoles.other).toBe('unused')
    expect(() => preparePstackUpdate({ roles: { '2review': 'chosen' } }, {})).toThrow('invalid pstack roles')
  })
  it('conflicts two process writes from one baseline and preserves both edits after a fresh retry', async () => {
    loadPstackPreferences()
    const children = ['first', 'second'].map(alias => configProcess(`const patch = { modelAliases: { ${alias}: { provider: 'test', model: '${alias}' } } }; const update = config.preparePstackUpdate(patch, {}); await waitForParent(); try { await update.persist(undefined); process.stdout.write('saved'); } catch (error) { process.stdout.write(error.message); }`))
    await Promise.all(children.map(child => child.started))
    children.forEach(child => child.resume())
    const results = await Promise.all(children.map(child => child.done))
    expect(results.filter(result => result === 'saved')).toHaveLength(1)
    expect(results.filter(result => result.includes('changed during setup'))).toHaveLength(1)
    const loser = results[0] === 'saved' ? 'second' : 'first'
    await savePstackPreferences({ modelAliases: { [loser]: { provider: 'test', model: loser } } })
    expect(Object.keys(loadPstackPreferences().modelAliases).sort()).toEqual(['first', 'second'])
    expect(readdirSync(join(home, 'dsh', 'pstack'))).toEqual(['config.json'])
  })
  it('times out on a live writer lock without modifying preferences', async () => {
    const prepared = preparePstackUpdate({ sessionHook: false }, {})
    const before = readFileSync(pstackConfigPath(), 'utf8')
    writeFileSync(`${pstackConfigPath()}.lock`, `${process.pid}\n`)
    await expect(prepared.persist(undefined)).rejects.toThrow('timed out waiting for the writer lock')
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
  })
})
