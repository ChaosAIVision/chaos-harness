import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { mintHumanApproval } from '@deepseek-ai/dsh-tool-subagent'
import { Config as ConfigSchema, install, loadPstackPreferences, pstackConfigPath, savePstackPreferences } from '@deepseek-ai/dsh-claude-compat'
import type { CompatHost, Config } from '@deepseek-ai/dsh-claude-compat'

interface Activation {
  readonly spec: Parameters<CompatHost['startActivation']>[0]
}

interface Harness {
  readonly host: CompatHost
  readonly activations: Activation[]
  readonly hooks: Array<{ configPath: string; pluginRoot: string; projectDir?: string; skipSessionStart?: boolean }>
  readonly contexts: Array<(isChild?: boolean) => string | undefined>
  readonly tool: Parameters<CompatHost['registerTool']>[0]
  readonly tools: Map<string, Parameters<CompatHost['registerTool']>[0]>
  readonly injected: string[]
}

const AGENT_MARKDOWN = '---\nname: comment-sicko\ndescription: A deranged comment-hater.\n---\n\n# Comment Sicko\n\nMy first output when spawned is exactly this.\n'

function llmStub(): NonNullable<CompatHost['llm']> {
  return {
    resolveModelInfo: async (provider, model) => {
      if (provider !== 'alpha' || !['judge', 'fast'].includes(model)) throw new Error(`unknown model ${provider}/${model}`)
      return { provider, id: model, name: model, reasoning: { efforts: model === 'judge' ? [{ id: ReasoningEffortId('high'), name: 'High' }] : [] } }
    },
    resolveCallConfig: async (selection) => {
      const { provider, model, reasoningEffort } = selection
      if (provider !== 'alpha' && provider !== 'beta') throw new Error(`LLM provider "${provider}" is not registered; available: alpha, beta`)
      if (provider !== 'alpha' || !['judge', 'fast'].includes(model)) throw new Error(`unknown model ${provider}/${model}`)
      const efforts = model === 'judge' ? ['high'] : []
      if (reasoningEffort !== undefined && !efforts.includes(reasoningEffort)) throw new Error(`model "${provider}/${model}" has no reasoning effort "${reasoningEffort}"`)
      return { provider, model, maxTokens: 1024, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    },
  }
}

async function harness(overrides: Partial<Config> = {}, policy?: CompatHost['modelSelectionPolicy'], widenSession?: CompatHost['widenSession'], isolateWorktree?: CompatHost['isolateWorktree']): Promise<Harness> {
  const activations: Activation[] = []
  const hooks: Harness['hooks'] = []
  const contexts: Harness['contexts'] = []
  let tool: Harness['tool'] | undefined
  const tools: Harness['tools'] = new Map()
  const injected: string[] = []
  const host: CompatHost = {
    registerTool(candidate) {
      tools.set(candidate.name, candidate)
      if (candidate.name === 'claude_agent') tool = candidate
      return () => {}
    },
    async startActivation(spec) {
      activations.push({ spec })
      return { childId: 'child-1', result: Promise.resolve(undefined) }
    },
    llm: llmStub(),
    ...isolateWorktree === undefined ? {} : { isolateWorktree },
    ...widenSession === undefined ? {} : { widenSession },
    injectContext: (_agent, text) => { injected.push(text) },
    ...policy === undefined ? {} : { modelSelectionPolicy: policy },
    onAgentCreated(context) { contexts.push((isChild = false) => context(isChild)) },
    mountHooks(config) {
      hooks.push(config)
    },
  }
  await install(host, {
    roots: [],
    provider: 'spawn',
    models: {},
    modelAliases: {},
    modelSelection: false,
    hooks: true,
    ...overrides,
  })
  if (tool === undefined) throw new Error('claude_agent was not registered')
  return { host, activations, hooks, tool, contexts, tools, injected }
}

const exec = { agent: { id: 'parent', options: { provider: 'alpha', model: 'judge' }, session: { requestHeader: () => undefined } }, signal: new AbortController().signal }
const task = { description: 'review', prompt: 'Say DONE and stop.' }

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-compat-'))
  vi.stubEnv('DSH_HOME', join(root, 'dsh-home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, 'agents-home'))
  await mkdir(join(root, 'agents'), { recursive: true })
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await mkdir(join(root, 'hooks'), { recursive: true })
  await writeFile(join(root, 'agents', 'comment-sicko.md'), AGENT_MARKDOWN)
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme' }))
  await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('claude-compat discovery', () => {
  it('leaves native context disabled when configuration omits pstack', () => {
    expect(ConfigSchema({ roots: [], provider: 'spawn', models: {}, modelAliases: {}, modelSelection: false, hooks: true }).pstack).toBeUndefined()
  })
  it('discovers authorized aliases and inherited-model efforts for setup without granting alias routes', async () => {
    const { tools } = await harness({ modelAliases: { opus: { provider: 'alpha', model: 'judge' }, fast: { provider: 'alpha', model: 'fast' } } })
    const discovery = tools.get('claude_agent_models')
    const result = await discovery?.execute({}, exec as never)
    expect(result).toEqual(expect.objectContaining({
      aliases: [
        expect.objectContaining({ alias: 'opus', allowed: true, efforts: ['high'] }),
        expect.objectContaining({ alias: 'fast', allowed: false, efforts: [] }),
      ],
      inherited: { provider: 'alpha', model: 'judge', allowed: true, efforts: ['high'] },
    }))
  })

  it('reports the recorded Session policy revision and the sheet digest the initialization text carries', async () => {
    const { tools, contexts } = await harness({ modelAliases: { opus: { provider: 'alpha', model: 'judge' } } },
      () => ({ routes: [{ provider: 'alpha', model: 'judge' }], revision: 3 }))
    const found = await tools.get('claude_agent_models')!.execute({}, exec as never) as { policyRevision: number; sheetDigest: string }
    expect(found.policyRevision).toBe(3)
    expect(contexts[0]!()).toContain(`pstack role sheet ${found.sheetDigest}.`)
  })

  it('refreshes discovery, dispatch, and initialization after preferences change on the same installed instance', async () => {
    const { tools, tool, contexts, activations } = await harness({ modelAliases: { pinned: { provider: 'alpha', model: 'judge' } } })
    const original = loadPstackPreferences()
    const write = (modelAliases: Config['modelAliases']) => writeFile(pstackConfigPath(), JSON.stringify({ ...original, modelAliases }))
    const discover = () => tools.get('claude_agent_models')!.execute({}, exec as never)
    await write({ old: { provider: 'alpha', model: 'judge' } })
    expect(await discover()).toMatchObject({ aliases: [expect.objectContaining({ alias: 'old' }), expect.objectContaining({ alias: 'pinned' })] })
    await write({ astra: { provider: 'alpha', model: 'judge' }, sol: { provider: 'alpha', model: 'fast' }, pinned: { provider: 'alpha', model: 'fast' } })
    expect(await discover()).toMatchObject({ aliases: [
      expect.objectContaining({ alias: 'astra', allowed: true, efforts: ['high'] }),
      expect.objectContaining({ alias: 'sol', allowed: false }),
      expect.objectContaining({ alias: 'pinned', model: 'judge', allowed: true }),
    ] })
    expect(contexts[0]!()).toContain('astra => alpha/judge')
    expect(contexts[0]!()).not.toContain('old =>')
    expect(contexts[0]!()).not.toContain('Pstack models are not configured')
    await tool.execute({ ...task, model: 'astra' }, exec as never)
    await tool.execute({ ...task, model: 'pinned' }, exec as never)
    expect(activations.map(item => item.spec.request.agentOptions)).toEqual([
      { provider: 'alpha', model: 'judge' }, { provider: 'alpha', model: 'judge' },
    ])
    await expect(tool.execute({ ...task, model: 'sol' }, exec as never)).rejects.toThrow()
    await expect(tool.execute({ ...task, model: 'old' }, exec as never)).rejects.toThrow('unknown model alias "old"; configured aliases: astra, sol, pinned')
    await write({ astra: { provider: 'alpha', model: 'fast' } })
    expect(await discover()).toMatchObject({ aliases: [
      expect.objectContaining({ alias: 'astra', model: 'fast', allowed: false }),
      expect.objectContaining({ alias: 'pinned', model: 'judge', allowed: true }),
    ] })
    await expect(tool.execute({ ...task, model: 'astra' }, exec as never)).rejects.toThrow()
    await write({ astra: { provider: 'beta', model: 'judge' } })
    await expect(tool.execute({ ...task, model: 'astra' }, exec as never)).rejects.toThrow()
    expect(activations).toHaveLength(2)
    await write({ astra: { provider: 'alpha', model: 'judge', reasoningEffort: 'unsupported' } })
    await expect(tool.execute({ ...task, model: 'astra' }, exec as never)).rejects.toThrow('reasoning effort')
    await write(original.modelAliases)
    expect(await discover()).toMatchObject({ aliases: [expect.objectContaining({ alias: 'pinned' })] })
    await expect(tool.execute({ ...task, model: 'astra' }, exec as never)).rejects.toThrow('unknown model alias')
    expect(activations).toHaveLength(2)
  })

  it('fails discovery and dispatch on malformed refreshed preferences without using stale aliases', async () => {
    const { tool, tools, activations } = await harness({ modelAliases: { pinned: { provider: 'alpha', model: 'judge' } } })
    await writeFile(pstackConfigPath(), '{broken')
    await expect(tools.get('claude_agent_models')!.execute({}, exec as never)).rejects.toThrow('Cannot load')
    await expect(tool.execute({ ...task, model: 'pinned' }, exec as never)).rejects.toThrow('Cannot load')
    expect(activations).toHaveLength(0)
  })

  it('keeps healthy aliases and inherited discovery when another alias is stale', async () => {
    const { tools } = await harness({ modelAliases: { good: { provider: 'alpha', model: 'judge' }, stale: { provider: 'alpha', model: 'gone' } } })
    const result = await tools.get('claude_agent_models')?.execute({}, exec as never)
    expect(JSON.stringify(result)).toContain('unknown model alpha/gone')
    expect(JSON.stringify(result)).toContain('"alias":"good"')
    expect(JSON.stringify(result)).toContain('"inherited"')
  })

  it('addresses an agent by plugin namespace and advertises every type', async () => {
    const { tool } = await harness({ roots: [root] })
    expect(tool.description).toContain('acme:comment-sicko — A deranged comment-hater.')
  })

  it('discovers the complete four named plus ten effort-agent installation catalog', async () => {
    for (const name of ['poteto-agent', 'thermo-nuclear-review-subagent', 'thermo-nuclear-code-quality-review-subagent']) {
      await writeFile(join(root, 'agents', `${name}.md`), `---\nname: ${name}\n---\nRole ${name}`)
    }
    await mkdir(join(root, 'effort-agents'))
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      for (const prefix of ['effort', 'poteto-agent']) {
        const name = `${prefix}-${level}`
        await writeFile(join(root, 'effort-agents', `${name}.md`), `---\nname: ${name}\neffort: ${level}\n---\nRole ${name}`)
      }
    }
    const { tool, activations } = await harness({ roots: [root] })
    expect(tool.description.match(/  - acme:/g)).toHaveLength(14)
    await tool.execute({ ...task, subagent_type: 'acme:poteto-agent-high' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toEqual({ reasoningEffort: 'high' })
    await expect(tool.execute({ ...task, subagent_type: 'acme:effort-max' }, exec as never)).rejects.toThrow('has no reasoning effort "max"')
  })

  it('falls back to the directory name when the manifest is absent', async () => {
    await rm(join(root, '.claude-plugin', 'plugin.json'))
    const { tool } = await harness({ roots: [root] })
    expect(tool.description).toContain(`${root.split('/').pop()}:comment-sicko`)
  })

  it('rejects an unknown subagent type with the known list', async () => {
    const { tool } = await harness({ roots: [root] })
    await expect(tool.execute({ ...task, subagent_type: 'acme:nope' }, exec as never))
      .rejects.toThrow('unknown subagent type "acme:nope"; available: general-purpose, acme:comment-sicko')
  })
})

describe('claude-compat dispatch', () => {
  it('runs generic panel members through the same alias resolver, including omitted type', async () => {
    const { tool, activations } = await harness({ modelAliases: { opus: { provider: 'alpha', model: 'judge' } } })
    for (const subagent_type of ['general-purpose', undefined]) {
      await tool.execute({ ...task, ...subagent_type === undefined ? {} : { subagent_type }, model: 'opus', run_in_background: true }, exec as never)
    }
    expect(activations).toHaveLength(2)
    expect(activations.every(a => a.spec.request.agentOptions?.model === 'judge')).toBe(true)
  })

  it('discovers effort declarations and applies them to inherited and alias models', async () => {
    await mkdir(join(root, 'effort-agents'))
    await writeFile(join(root, 'effort-agents', 'effort-high.md'), '---\nname: effort-high\neffort: high\n---\nDo the task.')
    const { tool, activations } = await harness({ roots: [root] })
    expect(tool.description).toContain('acme:effort-high')
    await tool.execute({ ...task, subagent_type: 'acme:effort-high', model: 'inherit-parent' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toEqual({ reasoningEffort: 'high' })
    await expect(tool.execute({ ...task, subagent_type: 'acme:effort-high', reasoning_effort: 'low' }, exec as never)).rejects.toThrow('conflicting')
  })

  it('honors a recorded policy for generic and named aliases but denies non-allowlisted routes', async () => {
    const { tool, activations } = await harness({ roots: [root], modelAliases: { fast: { provider: 'alpha', model: 'fast' }, judge: { provider: 'alpha', model: 'judge' } } },
      () => ({ routes: [{ provider: 'alpha', model: 'fast' }] }))
    for (const subagent_type of ['general-purpose', 'acme:comment-sicko']) {
      await tool.execute({ ...task, subagent_type, model: 'fast' }, exec as never)
      await expect(tool.execute({ ...task, subagent_type, model: 'judge' }, exec as never)).rejects.toThrow('not allowed')
    }
    expect(activations).toHaveLength(2)
  })

  it('rejects unsupported alias effort before dispatch even when route is authorized', async () => {
    const { tool, activations } = await harness({ modelAliases: { bad: { provider: 'alpha', model: 'judge', reasoningEffort: 'max' } } })
    await expect(tool.execute({ ...task, model: 'bad' }, exec as never)).rejects.toThrow('has no reasoning effort "max"')
    expect(activations).toEqual([])
  })

  it('rejects synchronous dispatch rather than ignoring run_in_background false', async () => {
    const { tool, activations } = await harness()
    await expect(tool.execute({ ...task, run_in_background: false }, exec as never)).rejects.toThrow('starts asynchronously')
    expect(activations).toEqual([])
  })

  it('does not authorize another route merely because an operator defined an alias', async () => {
    const { tool, activations } = await harness({ modelAliases: { fast: { provider: 'alpha', model: 'fast' } } })
    await expect(tool.execute({ ...task, subagent_type: 'general-purpose', model: 'fast' }, exec as never)).rejects.toThrow('not allowed')
    expect(activations).toEqual([])
  })

  it('forwards the parent, the declaration, and the task, and inherits the route', async () => {
    const { tool, activations } = await harness({ roots: [root] })
    const value = await tool.execute({ ...task, subagent_type: 'acme:comment-sicko' }, exec as never)
    expect(value).toBe('Started acme:comment-sicko as subagent child-1 on parent route. Its result arrives as a message.')
    const [activation] = activations
    expect(activation?.spec.provider).toBe('spawn')
    expect(activation?.spec.delivery).toBe('parent')
    expect(activation?.spec.request.parent).toBe(exec.agent)
    expect(activation?.spec.request.agentOptions).toBeUndefined()
    const text = (activation?.spec.request.prompt[0] as { text: string }).text
    expect(text).toContain('# Comment Sicko')
    expect(text).toContain('Say DONE and stop.')
  })

  it('requests edit/write denial and a no-mutation prompt for readonly generic explorers', async () => {
    const { tool, activations } = await harness()
    await tool.execute({ ...task, readonly: true }, exec as never)
    expect(activations[0]?.spec.request.toolFilter).toEqual({ deny: ['edit', 'write'] })
    const prompt = activations[0]?.spec.request.prompt[0]
    expect(prompt?.type).toBe('text')
    if (prompt?.type !== 'text') throw new Error('expected text prompt')
    expect(prompt.text).toContain('do not modify files or mutate external state')
    expect(tool.description).toContain('interrupt_agent(agent_id)')
    expect(tool.description).toContain('list_agents')
    expect(tool.isConcurrencySafe?.(task)).toBe(true)
  })

  it('passes the requested child directory through', async () => {
    const { tool, activations } = await harness({ roots: [root] })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', cwd: '/tmp' }, exec as never)
    expect(activations[0]?.spec.request.cwd).toBe('/tmp')
  })
})

describe('claude-compat routes', () => {
  it('uses the route configured for the exact type and advertises it', async () => {
    const { tool, activations } = await harness({
      roots: [root],
      models: { 'acme:comment-sicko': { provider: 'alpha', model: 'judge' } },
    })
    const value = await tool.execute({ ...task, subagent_type: 'acme:comment-sicko' }, exec as never)
    expect(value).toContain('on alpha/judge')
    expect(activations[0]?.spec.request.agentOptions).toEqual({ provider: 'alpha', model: 'judge' })
    expect(tool.description).toContain('[model alpha/judge]')
  })

  it('falls back to the wildcard route', async () => {
    const { tool, activations } = await harness({
      roots: [root],
      models: { '*': { provider: 'alpha', model: 'fast' } },
    })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toEqual({ provider: 'alpha', model: 'fast' })
  })

  it('lets a model-supplied route override the configured one', async () => {
    const { tool, activations } = await harness({
      roots: [root],
      modelSelection: true,
      models: { '*': { provider: 'alpha', model: 'fast' } },
    })
    const value = await tool.execute({
      ...task,
      subagent_type: 'acme:comment-sicko',
      provider: 'alpha',
      model: 'judge',
      reasoning_effort: 'high',
    }, exec as never)
    expect(value).toContain('on alpha/judge')
    expect(activations[0]?.spec.request.agentOptions).toEqual({ provider: 'alpha', model: 'judge', reasoningEffort: 'high' })
  })

  it('rejects an unregistered provider and an unsupported effort', async () => {
    const { tool } = await harness({ roots: [root], modelSelection: true }, () => ({ routes: [
      { provider: 'nope', model: 'x' }, { provider: 'alpha', model: 'fast' },
    ] }))
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', provider: 'nope', model: 'x' }, exec as never))
      .rejects.toThrow('LLM provider "nope" is not registered; available: alpha, beta')
    await expect(tool.execute({
      ...task, subagent_type: 'acme:comment-sicko', provider: 'alpha', model: 'fast', reasoning_effort: 'high',
    }, exec as never)).rejects.toThrow('model "alpha/fast" has no reasoning effort "high"')
  })

  it('resolves model-only aliases, advertises them, and preserves configured effort', async () => {
    const { tool, activations } = await harness({
      roots: [root],
      modelAliases: { opus: { provider: 'alpha', model: 'judge', reasoningEffort: 'high' } },
    })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'opus' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toEqual({ provider: 'alpha', model: 'judge', reasoningEffort: 'high' })
    expect(tool.description).toContain('claude_agent_models returns the current aliases, roles, default effort, sessionHook, policyRevision, and sheetDigest and is authoritative.')
  })

  it.each(['auto', 'inherit-parent'])('omits child options for %s', async (model) => {
    const { tool, activations } = await harness({ roots: [root] })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model }, exec as never)
    expect(activations[0]?.spec.request).not.toHaveProperty('agentOptions')
  })

  it('rejects conflicting aliases instead of silently ignoring the choice', async () => {
    const { tool, activations } = await harness({
      roots: [root],
      models: { '*': { provider: 'alpha', model: 'fast' } },
      modelAliases: { opus: { provider: 'alpha', model: 'judge' } },
    })
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'opus' }, exec as never)).rejects.toThrow('configured route')
    expect(activations).toEqual([])
  })

  it.each(['judge', 'fast'])('preserves parent effort over alias default for session on %s', async (model) => {
    const { tool, activations } = await harness({ modelAliases: { choice: { provider: 'alpha', model, reasoningEffort: 'max' } } },
      () => ({ routes: [{ provider: 'alpha', model }] }))
    const sessionExec = { ...exec, agent: { ...exec.agent, options: { ...exec.agent.options, reasoningEffort: ReasoningEffortId('high') } } }
    const call = tool.execute({ ...task, model: 'choice', reasoning_effort: 'session' }, sessionExec as never)
    if (model === 'fast') {
      await expect(call).rejects.toThrow('has no reasoning effort "high"')
      expect(activations).toEqual([])
    } else {
      await call
      expect(activations[0]?.spec.request.agentOptions?.reasoningEffort).toBe('high')
    }
  })

  it('applies explicit effort on the inherited model', async () => {
    const { tool, activations } = await harness({ roots: [root] })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'auto', reasoning_effort: 'high' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toEqual({ reasoningEffort: 'high' })
  })

  it('rejects unknown aliases without starting a child', async () => {
    const { tool, activations } = await harness({ roots: [root] })
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'typo' }, exec as never))
      .rejects.toThrow('unknown model alias "typo"')
    expect(activations).toEqual([])
  })

  it('requires provider and model together', async () => {
    const { tool } = await harness({ roots: [root], modelSelection: true })
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'judge' }, exec as never))
      .rejects.toThrow('unknown model alias "judge"')
  })

  it('hides raw route parameters and rejects them at the executor while selection is off', async () => {
    const { tool, activations } = await harness({ roots: [root] })
    const parameters = tool.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).not.toHaveProperty('provider')
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', provider: 'alpha', model: 'judge' }, exec as never)).rejects.toThrow('disabled')
    expect(activations).toEqual([])
  })
})

describe('pstack setup approval', () => {
  async function setup(widen?: CompatHost['widenSession']) {
    await mkdir(join(root, 'agents-home', 'pstack-plugin', 'hooks'), { recursive: true })
    await writeFile(join(root, 'agents-home', 'pstack-plugin', 'hooks', 'session-start-context.md'), 'mandate')
    return harness({}, undefined, widen)
  }
  type Steps = Parameters<NonNullable<CompatHost['widenSession']>>[2]
  const widening = (answer: 'yes' | 'no', revision = 2) => vi.fn(async (_exec: unknown, routes: readonly { provider: string; model: string }[], steps: Steps) => {
    if (routes.length === 0 && steps.unsaved.length === 0) return { kind: 'unchanged' as const, revision: 1, saved: await steps.persist(undefined) }
    if (answer === 'no') return { kind: 'declined' as const }
    return { kind: 'widened' as const, revision, saved: await steps.persist(mintHumanApproval(routes)) }
  })
  const preferences_json = JSON.stringify({ modelAliases: { chosen: { provider: 'alpha', model: 'judge' } }, roles: { 'feature, refactoring': 'chosen @high' } })
  it('fails closed without a widening seam when routes need confirmation', async () => {
    const { tools, injected } = await setup()
    await expect(tools.get('claude_agent_setup')!.execute({ preferences_json }, exec as never)).rejects.toThrow('not authorized')
    expect(loadPstackPreferences()?.allowedModels).toEqual([])
    expect(injected).toEqual([])
  })
  it('saves nothing after direct human denial', async () => {
    const widen = widening('no')
    const { tools, injected } = await setup(widen)
    await expect(tools.get('claude_agent_setup')!.execute({ preferences_json }, exec as never)).rejects.toThrow('not authorized')
    expect(widen).toHaveBeenCalledOnce()
    expect(loadPstackPreferences()?.modelAliases).toEqual({})
    expect(injected).toEqual([])
  })
  it('persists exact routes only after direct human confirmation, preserves other roles, and injects the new sheet', async () => {
    const widen = widening('yes')
    const { tools, injected } = await setup(widen)
    const message = await tools.get('claude_agent_setup')!.execute({ preferences_json }, exec as never)
    expect(widen.mock.calls[0]?.[1]).toEqual([{ provider: 'alpha', model: 'judge' }])
    expect(widen.mock.calls[0]?.[2].unsaved).toEqual([{ provider: 'alpha', model: 'judge' }])
    expect(loadPstackPreferences()?.allowedModels).toEqual([{ provider: 'alpha', model: 'judge' }])
    expect(Object.keys(loadPstackPreferences().roles)).toHaveLength(17)
    expect(injected).toHaveLength(1)
    expect(injected[0]).toContain('chosen => alpha/judge')
    expect(injected[0]).toContain('feature, refactoring: chosen @high')
    const digest = /pstack role sheet ([0-9a-f]{8})\./.exec(injected[0]!)?.[1]
    expect(message).toContain('Session policy revision 2 is active now.')
    expect(message).toContain(`Role sheet ${digest} was injected`)
  })
  it('injects a refreshed sheet for a roles-only edit without asking about routes', async () => {
    const widen = widening('yes')
    const { tools, injected } = await setup(widen)
    await tools.get('claude_agent_setup')!.execute({ preferences_json: JSON.stringify({ roles: { 'bug-fix': 'inherit-parent' }, defaultEffort: 'high' }) }, exec as never)
    expect(widen.mock.calls[0]?.[1]).toEqual([])
    expect(widen.mock.calls[0]?.[2].unsaved).toEqual([])
    expect(injected[0]).toContain('default effort: high')
  })
  it('refuses allowedModels in the model-supplied JSON before any question is asked', async () => {
    const widen = widening('yes')
    const { tools } = await setup(widen)
    await expect(tools.get('claude_agent_setup')!.execute({ preferences_json: JSON.stringify({ allowedModels: [{ provider: 'evil', model: 'x' }] }) }, exec as never)).rejects.toThrow('operator-owned')
    expect(widen).not.toHaveBeenCalled()
    expect(loadPstackPreferences()?.allowedModels).toEqual([])
  })
  it('validates and confirms the exact profile override while keeping saved aliases self-contained', async () => {
    await savePstackPreferences({ modelAliases: { chosen: { provider: 'alpha', model: 'fast' } } })
    const widen = widening('yes')
    const { tools, injected } = await harness({ modelAliases: { chosen: { provider: 'alpha', model: 'judge' } } }, undefined, widen)
    await tools.get('claude_agent_setup')!.execute({ preferences_json: JSON.stringify({ roles: { review2: 'chosen @high' } }) }, exec as never)
    expect(widen.mock.calls[0]?.[1]).toEqual([{ provider: 'alpha', model: 'judge' }])
    expect(loadPstackPreferences().modelAliases.chosen).toEqual({ provider: 'alpha', model: 'fast' })
    expect(loadPstackPreferences().allowedModels).toEqual([{ provider: 'alpha', model: 'judge' }])
    expect(injected[0]).toContain('chosen => alpha/judge')
  })
  it('rejects efforts unsupported by a profile override before asking for authorization', async () => {
    await savePstackPreferences({ modelAliases: { chosen: { provider: 'alpha', model: 'judge' } } })
    const widen = widening('yes')
    const { tools } = await harness({ modelAliases: { chosen: { provider: 'alpha', model: 'fast' } } }, undefined, widen)
    await expect(tools.get('claude_agent_setup')!.execute({ preferences_json: JSON.stringify({ roles: { review2: 'chosen @high' } }) }, exec as never)).rejects.toThrow('does not support effort high')
    expect(widen).not.toHaveBeenCalled()
  })
  it('validates default effort against inherited roles even when the file has no aliases or roles', async () => {
    await writeFile(pstackConfigPath(), JSON.stringify({ ...loadPstackPreferences(), roles: {}, modelAliases: {} }))
    const widen = widening('yes')
    const { tools } = await harness({}, undefined, widen)
    await expect(tools.get('claude_agent_setup')!.execute({ preferences_json: JSON.stringify({ defaultEffort: 'unsupported' }) }, exec as never)).rejects.toThrow('does not support effort unsupported')
    expect(widen).not.toHaveBeenCalled()
  })
  it('reports the role sheet, default effort, and policy revision in discovery', async () => {
    const widen = widening('yes')
    const { tools, injected } = await setup(widen)
    await tools.get('claude_agent_setup')!.execute({ preferences_json }, exec as never)
    const found = await tools.get('claude_agent_models')!.execute({}, exec as never) as { roles: Record<string, string>; defaultEffort: string; sheetDigest: string; policyRevision?: number }
    expect(found.roles['feature, refactoring']).toBe('chosen @high')
    expect(found.defaultEffort).toBe('session')
    expect(found.sheetDigest).toBe(/pstack role sheet ([0-9a-f]{8})\./.exec(injected[0]!)?.[1])
    expect(found).not.toHaveProperty('policyRevision')
  })
})

describe('native pstack initialization', () => {
  it('loads the mandate and configured sheet at initialization without duplicating SessionStart', async () => {
    const sheetPath = join(root, 'sheet.md')
    await writeFile(sheetPath, '\uFEFFsession hook: on\r\nbug-fix: opus\r\narchitect runners: FastJudge @high, inherit-parent @high, auto\r\ndefault effort: high\r\n')
    await writeFile(join(root, 'hooks', 'session-start-context.md'), '<IMPORTANT>Invoke pstack:poteto-mode</IMPORTANT>')
    const { contexts, hooks } = await harness({ roots: [root], hooks: false, pstack: { root, sheetPath } })
    expect(hooks).toEqual([])
    expect(contexts[0]?.()).toContain('Invoke pstack:poteto-mode')
    expect(contexts[0]?.()).toContain('bug-fix: opus')
    expect(contexts[0]?.()).toContain('architect runners: FastJudge @high, inherit-parent @high, auto')
    expect(contexts[0]?.()).toContain('default effort: high')
    expect(contexts[0]?.()).toContain('Entries without a suffix use default effort; absent default or session passes reasoning_effort: session')
    expect(contexts[0]?.()).toContain('Never collapse panel entries, including inherited entries')
    expect(contexts[0]?.(true)).not.toContain('Invoke pstack:poteto-mode')
    expect(contexts[0]?.()).toContain('use claude_agent, not the standard subagent tool')
    await writeFile(sheetPath, '\uFEFFsession hook: off\r\n', 'utf16le')
    expect(contexts[0]?.()).not.toContain('Invoke pstack:poteto-mode')
    expect(contexts[0]?.()).toContain('claude_agent')
    const bridged = await harness({ roots: [root], pstack: { root, sheetPath } })
    expect(bridged.hooks[0]?.skipSessionStart).toBe(true)
  })
})

describe('claude-compat hooks', () => {
  it('mounts one bridge for a root that has hooks.json', async () => {
    const { hooks } = await harness({ roots: [root] })
    expect(hooks).toEqual([{ configPath: join(root, 'hooks', 'hooks.json'), pluginRoot: root }])
  })

  it('mounts nothing when hooks are disabled', async () => {
    const { hooks } = await harness({ roots: [root], hooks: false })
    expect(hooks).toEqual([])
  })
})

describe('worktree isolation admission', () => {
  it('hides isolation without its service and denies direct executor requests', async () => {
    const { tool, activations } = await harness()
    const parameters = tool.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).not.toHaveProperty('isolation')
    await expect(tool.execute({ ...task, isolation: 'worktree' }, exec as never)).rejects.toThrow('requires the worktree service')
    expect(activations).toEqual([])
  })

  it('offers only worktree isolation and passes the source cwd and parent to the capability', async () => {
    const isolate = vi.fn<NonNullable<CompatHost['isolateWorktree']>>(async (_parent, _cwd, start) => ({
      activation: await start('/leased/subdir'), description: 'Worktree isolation: /leased/subdir.',
    }))
    const { tool, activations } = await harness({}, undefined, undefined, isolate)
    const parameters = tool.parameters as { properties?: Record<string, { enum?: string[] }> }
    expect(parameters.properties?.isolation?.enum).toEqual(['worktree'])
    const result = await tool.execute({ ...task, cwd: 'subdir', isolation: 'worktree' }, exec as never)
    expect(isolate.mock.calls[0]?.[0]).toBe(exec.agent)
    expect(isolate.mock.calls[0]?.[1]).toBe('subdir')
    expect(activations[0]?.spec.request.cwd).toBe('/leased/subdir')
    expect(activations[0]?.spec.delivery).toBe('parent')
    expect(result).toContain('Worktree isolation: /leased/subdir.')
    await expect(tool.execute({ ...task, isolation: 'other' }, exec as never)).rejects.toThrow('must be one of')
    expect(isolate).toHaveBeenCalledTimes(1)
  })
})
