import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Config as ConfigSchema, install } from '@deepseek-ai/dsh-claude-compat'
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
}

const AGENT_MARKDOWN = '---\nname: comment-sicko\ndescription: A deranged comment-hater.\n---\n\n# Comment Sicko\n\nMy first output when spawned is exactly this.\n'

function llmStub(): NonNullable<CompatHost['llm']> {
  return {
    listProviders: () => [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
    resolveModelInfo: async (provider, model) => {
      if (provider === 'alpha' && model === 'judge') {
        return {
          provider,
          id: model,
          name: 'Judge',
          reasoning: {
            efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
            defaultEffort: ReasoningEffortId('high'),
          },
        }
      }
      if (provider === 'alpha' && model === 'fast') {
        return { provider, id: model, name: 'Fast', reasoning: { efforts: [] } }
      }
      throw new Error(`unknown model ${provider}/${model}`)
    },
  }
}

function harness(overrides: Partial<Config> = {}): Harness {
  const activations: Activation[] = []
  const hooks: Harness['hooks'] = []
  const contexts: Harness['contexts'] = []
  let tool: Harness['tool'] | undefined
  const host: CompatHost = {
    registerTool(candidate) {
      tool = candidate
      return () => {}
    },
    async startActivation(spec) {
      activations.push({ spec })
      return { childId: 'child-1' }
    },
    llm: llmStub(),
    onAgentCreated(context) { contexts.push((isChild = false) => context(isChild)) },
    mountHooks(config) {
      hooks.push(config)
    },
  }
  install(host, {
    roots: [],
    provider: 'spawn',
    models: {},
    modelAliases: {},
    modelSelection: false,
    hooks: true,
    ...overrides,
  })
  if (tool === undefined) throw new Error('claude_agent was not registered')
  return { host, activations, hooks, tool, contexts }
}

const exec = { agent: { id: 'parent' }, signal: new AbortController().signal }
const task = { description: 'review', prompt: 'Say DONE and stop.' }

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claude-compat-'))
  await mkdir(join(root, 'agents'), { recursive: true })
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await mkdir(join(root, 'hooks'), { recursive: true })
  await writeFile(join(root, 'agents', 'comment-sicko.md'), AGENT_MARKDOWN)
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'acme' }))
  await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('claude-compat discovery', () => {
  it('leaves native context disabled when configuration omits pstack', () => {
    expect(ConfigSchema({ roots: [], provider: 'spawn', models: {}, modelAliases: {}, modelSelection: false, hooks: true }).pstack).toBeUndefined()
  })
  it('addresses an agent by plugin namespace and advertises every type', () => {
    const { tool } = harness({ roots: [root] })
    expect(tool.description).toContain('acme:comment-sicko — A deranged comment-hater.')
  })

  it('falls back to the directory name when the manifest is absent', async () => {
    await rm(join(root, '.claude-plugin', 'plugin.json'))
    const { tool } = harness({ roots: [root] })
    expect(tool.description).toContain(`${root.split('/').pop()}:comment-sicko`)
  })

  it('rejects an unknown subagent type with the known list', async () => {
    const { tool } = harness({ roots: [root] })
    await expect(tool.execute({ ...task, subagent_type: 'acme:nope' }, exec as never))
      .rejects.toThrow('unknown subagent type "acme:nope"; available: acme:comment-sicko')
  })
})

describe('claude-compat dispatch', () => {
  it('forwards the parent, the declaration, and the task, and inherits the route', async () => {
    const { tool, activations } = harness({ roots: [root] })
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

  it('passes the requested child directory through', async () => {
    const { tool, activations } = harness({ roots: [root] })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', cwd: '/tmp' }, exec as never)
    expect(activations[0]?.spec.request.cwd).toBe('/tmp')
  })
})

describe('claude-compat routes', () => {
  it('uses the route configured for the exact type and advertises it', async () => {
    const { tool, activations } = harness({
      roots: [root],
      models: { 'acme:comment-sicko': { provider: 'alpha', model: 'judge' } },
    })
    const value = await tool.execute({ ...task, subagent_type: 'acme:comment-sicko' }, exec as never)
    expect(value).toContain('on alpha/judge')
    expect(activations[0]?.spec.request.agentOptions).toEqual({ provider: 'alpha', model: 'judge' })
    expect(tool.description).toContain('[model alpha/judge]')
  })

  it('falls back to the wildcard route', async () => {
    const { tool, activations } = harness({
      roots: [root],
      models: { '*': { provider: 'alpha', model: 'fast' } },
    })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toEqual({ provider: 'alpha', model: 'fast' })
  })

  it('lets a model-supplied route override the configured one', async () => {
    const { tool, activations } = harness({
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
    const { tool } = harness({ roots: [root], modelSelection: true })
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', provider: 'nope', model: 'x' }, exec as never))
      .rejects.toThrow('LLM provider "nope" is not registered; available: alpha, beta')
    await expect(tool.execute({
      ...task, subagent_type: 'acme:comment-sicko', provider: 'alpha', model: 'fast', reasoning_effort: 'high',
    }, exec as never)).rejects.toThrow('model "alpha/fast" has no reasoning effort "high"')
  })

  it('resolves model-only aliases, advertises them, and preserves configured effort', async () => {
    const { tool, activations } = harness({
      roots: [root],
      modelAliases: { opus: { provider: 'alpha', model: 'judge', reasoningEffort: 'high' } },
    })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'opus' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toEqual({ provider: 'alpha', model: 'judge', reasoningEffort: 'high' })
    expect(tool.description).toContain('opus => alpha/judge @high')
  })

  it.each(['auto', 'inherit-parent'])('omits child options for %s', async (model) => {
    const { tool, activations } = harness({ roots: [root] })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model }, exec as never)
    expect(activations[0]?.spec.request).not.toHaveProperty('agentOptions')
  })

  it('keeps explicit type routes authoritative over aliases', async () => {
    const { tool, activations } = harness({
      roots: [root],
      models: { '*': { provider: 'alpha', model: 'fast' } },
      modelAliases: { opus: { provider: 'alpha', model: 'judge' } },
    })
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'opus' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toEqual({ provider: 'alpha', model: 'fast' })
  })

  it('rejects inherited aliases combined with an effort instead of discarding it', async () => {
    const { tool, activations } = harness({ roots: [root], modelSelection: true })
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'auto', reasoning_effort: 'high' }, exec as never))
      .rejects.toThrow('cannot be combined with reasoning_effort')
    expect(activations).toEqual([])
  })

  it('rejects unknown aliases without starting a child', async () => {
    const { tool, activations } = harness({ roots: [root] })
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'typo' }, exec as never))
      .rejects.toThrow('unknown model alias "typo"')
    expect(activations).toEqual([])
  })

  it('requires provider and model together', async () => {
    const { tool } = harness({ roots: [root], modelSelection: true })
    await expect(tool.execute({ ...task, subagent_type: 'acme:comment-sicko', model: 'judge' }, exec as never))
      .rejects.toThrow('unknown model alias "judge"')
  })

  it('hides the route parameters and ignores them while selection is off', async () => {
    const { tool, activations } = harness({ roots: [root] })
    const parameters = tool.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).not.toHaveProperty('provider')
    await tool.execute({ ...task, subagent_type: 'acme:comment-sicko', provider: 'alpha', model: 'judge' }, exec as never)
    expect(activations[0]?.spec.request.agentOptions).toBeUndefined()
  })
})

describe('native pstack initialization', () => {
  it('loads the mandate and configured sheet at initialization without duplicating SessionStart', async () => {
    const sheetPath = join(root, 'sheet.md')
    await writeFile(sheetPath, '\uFEFFsession hook: on\r\nbug-fix: opus\r\n')
    await writeFile(join(root, 'hooks', 'session-start-context.md'), '<IMPORTANT>Invoke pstack:poteto-mode</IMPORTANT>')
    const { contexts, hooks } = harness({ roots: [root], hooks: false, pstack: { root, sheetPath } })
    expect(hooks).toEqual([])
    expect(contexts[0]?.()).toContain('Invoke pstack:poteto-mode')
    expect(contexts[0]?.()).toContain('bug-fix: opus')
    expect(contexts[0]?.(true)).not.toContain('Invoke pstack:poteto-mode')
    expect(contexts[0]?.()).toContain('use claude_agent, not the standard subagent tool')
    await writeFile(sheetPath, '\uFEFFsession hook: off\r\n', 'utf16le')
    expect(contexts[0]?.()).not.toContain('Invoke pstack:poteto-mode')
    expect(contexts[0]?.()).toContain('claude_agent')
    const bridged = harness({ roots: [root], pstack: { root, sheetPath } })
    expect(bridged.hooks[0]?.skipSessionStart).toBe(true)
  })
})

describe('claude-compat hooks', () => {
  it('mounts one bridge for a root that has hooks.json', () => {
    const { hooks } = harness({ roots: [root] })
    expect(hooks).toEqual([{ configPath: join(root, 'hooks', 'hooks.json'), pluginRoot: root }])
  })

  it('mounts nothing when hooks are disabled', () => {
    const { hooks } = harness({ roots: [root], hooks: false })
    expect(hooks).toEqual([])
  })
})
