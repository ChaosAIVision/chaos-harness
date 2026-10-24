/** claude_agent_setup against the real settings service, policy projection, and Session log. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import Skills from '@deepseek-ai/dsh-skill'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as compat from '../src/index.ts'
import { loadPstackPreferences, pstackConfigPath } from '../src/index.ts'

type Answer = 'Authorize routes' | 'Cancel'

class ScriptedHuman extends Service {
  readonly asked: string[] = []
  answer: Answer = 'Authorize routes'

  constructor(ctx: Context) { super(ctx, 'userQuestions') }

  async ask(request: { questions: Array<{ id: string; question: string }> }) {
    this.asked.push(request.questions[0]!.question)
    return { answers: [{ id: request.questions[0]!.id, selected: [this.answer] }] }
  }
}

let home = ''
let ctxs: Context[] = []
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pstack-widening-'))
  vi.stubEnv('DSH_HOME', join(home, 'dsh'))
  vi.stubEnv('DSH_AGENTS_HOME', join(home, 'shared'))
})
afterEach(async () => {
  for (const ctx of ctxs) await ctx.fiber.dispose()
  ctxs = []
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

const A = { provider: 'alpha', model: 'fast' }
const B = { provider: 'beta', model: 'big' }

function seedConfig(update: Record<string, unknown>): void {
  const base = loadPstackPreferences()
  mkdirSync(join(home, 'dsh', 'pstack'), { recursive: true })
  writeFileSync(pstackConfigPath(), JSON.stringify({ ...base, ...update }))
}

async function boot(withHuman = true) {
  const ctx = new Context()
  ctxs.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SubagentModelSelectionConfig, { enabled: null, allowedModels: [] })
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await liveConfig(ctx, SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['alpha', 'beta', 'mock'], new MockAdapter([]))
  let human: ScriptedHuman | undefined
  if (withHuman) {
    human = new ScriptedHuman(ctx)
  }
  await ctx.plugin(Skills)
  const preset = createScope(ctx, { preset: 'pstack-widening' })
  const loaded = preset.ctx.plugin({ inject: compat.inject, apply: compat.apply }, { roots: [], provider: 'spawn', models: {}, modelAliases: {}, modelSelection: false, hooks: false })
  await loaded.await()
  const agent = (await ctx.agents.create({
    sessionId: SessionId('widening-parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: (agentCtx) => { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
  })).agent
  const call = (name: string, args: Record<string, unknown>, caller: Agent = agent) => executeToolFixture(ctx, {
    signal: new AbortController().signal, callId: ToolCallId(`c-${Math.random()}`), name, arguments: args, agent: caller,
  })
  const text = (result: Awaited<ReturnType<typeof call>>) =>
    result.content.map(block => block.type === 'text' ? block.text : '').join('')
  const setup = (update: Record<string, unknown>) => call('claude_agent_setup', { preferences_json: JSON.stringify(update) })
  const discover = async () => JSON.parse(text(await call('claude_agent_models', {}))) as {
    aliases: Array<{ alias: string; allowed: boolean }>
    policyRevision?: number
    sheetDigest: string
  }
  const dispatchBlocked = async (alias: string) =>
    text(await call('claude_agent', { description: 'probe', prompt: 'go', model: alias })).includes('is not allowed for this Session')
  return { ctx, agent, human, call, text, setup, discover, dispatchBlocked }
}

const policyEntries = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy')

describe('claude_agent_setup in a running Session', () => {
  it('unlocks a newly approved alias in the same Session and refreshes the role sheet', async () => {
    seedConfig({ modelAliases: { fast: { provider: 'alpha', model: 'fast', reasoningEffort: undefined }, big: { provider: 'beta', model: 'big' } }, allowedModels: [A] })
    const { agent, human, setup, discover, dispatchBlocked } = await boot()
    expect(await dispatchBlocked('big')).toBe(true)

    const result = await setup({ roles: { 'bug-fix': 'big' } })

    expect(result.isError).toBe(false)
    expect(human!.asked).toHaveLength(1)
    expect(human!.asked[0]).toContain('beta/big')
    expect(await dispatchBlocked('big')).toBe(false)
    const found = await discover()
    expect(found.aliases).toEqual([expect.objectContaining({ alias: 'fast', allowed: true }), expect.objectContaining({ alias: 'big', allowed: true })])
    expect(found.policyRevision).toBe(2)
    expect(policyEntries(agent).map(event => event.data)).toEqual([
      { allowedModels: [A] },
      { allowedModels: [A, B], origin: 'setup', revision: 2 },
    ])
    const sheets = agent.session.snapshotEvents().flatMap(event => [...JSON.stringify(event).matchAll(/pstack role sheet ([0-9a-f]{8})\./g)]
      .map(match => ({ seq: event.seq, digest: match[1] })))
    expect(sheets).toHaveLength(2)
    expect(sheets[1]?.digest).toBe(found.sheetDigest)
    expect(sheets[0]!.digest).not.toBe(found.sheetDigest)
    expect(sheets[1]!.seq).toBeGreaterThan(policyEntries(agent)[1]!.seq)
    expect(loadPstackPreferences().allowedModels).toEqual([A, B])
  })

  it('grants nothing when a shell edit of config.json is followed by a roles-only setup call', async () => {
    seedConfig({ modelAliases: { fast: A }, allowedModels: [A] })
    const { agent, human, setup, discover, dispatchBlocked } = await boot()
    seedConfig({ modelAliases: { fast: A }, allowedModels: [A, B] })

    const result = await setup({ roles: { 'bug-fix': 'fast' } })

    expect(result.isError).toBe(false)
    expect(human!.asked).toEqual([])
    expect(policyEntries(agent)).toHaveLength(1)
    expect(await dispatchBlocked('fast')).toBe(false)
    expect((await discover()).policyRevision).toBe(1)
    expect(loadPstackPreferences().allowedModels).toEqual([A, B])
  })

  it('grants nothing when a shell edit also adds the alias and the person declines', async () => {
    seedConfig({ modelAliases: { fast: A }, allowedModels: [A] })
    const { agent, human, setup, dispatchBlocked } = await boot()
    human!.answer = 'Cancel'
    seedConfig({ modelAliases: { fast: A, big: B }, allowedModels: [A, B] })
    const before = readFileSync(pstackConfigPath(), 'utf8')

    const result = await setup({ roles: { 'bug-fix': 'big' } })

    expect(result.isError).toBe(true)
    expect(human!.asked).toHaveLength(1)
    expect(policyEntries(agent)).toHaveLength(1)
    expect(await dispatchBlocked('big')).toBe(true)
    expect(readFileSync(pstackConfigPath(), 'utf8')).toBe(before)
  })

  it('grants nothing when a shell edit adds the alias and no human question service exists', async () => {
    seedConfig({ modelAliases: { fast: A }, allowedModels: [A] })
    const { agent, setup, dispatchBlocked } = await boot(false)
    seedConfig({ modelAliases: { fast: A, big: B }, allowedModels: [A, B] })

    const result = await setup({ roles: { 'bug-fix': 'big' } })

    expect(result.isError).toBe(true)
    expect(policyEntries(agent)).toHaveLength(1)
    expect(await dispatchBlocked('big')).toBe(true)
  })

  it('changes nothing in a running Session when the model edits config.json directly', async () => {
    seedConfig({ modelAliases: { fast: A, big: B }, allowedModels: [A] })
    const { agent, discover, dispatchBlocked } = await boot()
    seedConfig({ modelAliases: { fast: A, big: B }, allowedModels: [A, B] })

    expect(await dispatchBlocked('big')).toBe(true)
    expect((await discover()).aliases).toEqual([expect.objectContaining({ alias: 'fast', allowed: true }), expect.objectContaining({ alias: 'big', allowed: false })])
    expect(policyEntries(agent)).toHaveLength(1)
  })

  it('rejects allowedModels from the model before asking anyone', async () => {
    seedConfig({ modelAliases: { fast: A }, allowedModels: [A] })
    const { human, call } = await boot()

    const result = await call('claude_agent_setup', { preferences_json: JSON.stringify({ allowedModels: [B] }) })

    expect(result.isError).toBe(true)
    expect(human!.asked).toEqual([])
    expect(loadPstackPreferences().allowedModels).toEqual([A])
  })

  it('lets a Session started after an approval hold the saved routes without asking', async () => {
    seedConfig({ modelAliases: { fast: A }, allowedModels: [A] })
    const first = await boot()
    await first.setup({ modelAliases: { big: B } })
    expect(first.human!.asked).toHaveLength(1)

    const second = await boot()
    expect(await second.dispatchBlocked('big')).toBe(false)
    await second.setup({ roles: { 'bug-fix': 'big' } })
    expect(second.human!.asked).toEqual([])
  })
})
