/** Human-approved widening of a running Session's route policy through the real settings service. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import * as tool from '../src/index.ts'
import { mintHumanApproval } from '../src/human-approval.ts'
import type { HumanApproval } from '../src/human-approval.ts'
import type { AllowedModelRoute } from '../src/model-selection.ts'
import SubagentModelSelectionConfig from '../src/model-selection-settings.ts'
import type { WidenSessionSteps } from '../src/model-selection-settings.ts'
import {
  sessionPolicy,
  subagentModelSelectionProjectionDefinition as definition,
} from '../src/model-selection-state.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import { ownContext, text } from './harness.ts'

const A: AllowedModelRoute = { provider: 'alpha', model: 'fast-model' }
const B: AllowedModelRoute = { provider: 'beta', model: 'big-model' }
const C: AllowedModelRoute = { provider: 'gamma', model: 'huge-model' }

let counter = 0

async function boot(enabled: boolean | null = true) {
  const ctx = ownContext(new Context())
  await mountAgentLoopTestDependencies(ctx)
  const config = await liveConfig(ctx, SubagentModelSelectionConfig)
  await config.update({ enabled, allowedModels: enabled === true ? [A] : [] })
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await liveConfig(ctx, SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const preset = createScope(ctx, { preset: 'widening-test' })
  await preset.ctx.plugin(tool, { provider: 'spawn', modelSelection: true, modelDiscovery: true })
  const policy = await ctx.sessionProjections.register(definition)
  const create = async (parent?: Agent, options: Agent['options'] = {}): Promise<Agent> => (await ctx.agents.create({
    sessionId: SessionId(`widening-${++counter}`),
    ...parent === undefined ? {} : { meta: { parentSession: parent.id, origin: 'subagent' as const } },
    agentOptions: options,
    setup: (agentCtx) => { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
  })).agent
  return { ctx, config, policy, create }
}

/** Dispatch through the real generic tool; routes outside the Session policy fail before any child starts. */
async function blocked(ctx: Context, agent: Agent, route: AllowedModelRoute): Promise<boolean> {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`dispatch-${++counter}`),
    name: 'subagent',
    arguments: { description: 'probe', prompt: 'work', ...route },
    agent,
  })
  return text(result).includes('is not allowed for this Session')
}

function entries(agent: Agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy')
}

interface Recorded extends WidenSessionSteps {
  readonly asked: AllowedModelRoute[][]
  readonly persisted: Array<HumanApproval | undefined>
}

function steps(answer: 'yes' | 'no', unsaved: readonly AllowedModelRoute[] = []): Recorded {
  const asked: AllowedModelRoute[][] = []
  const persisted: Array<HumanApproval | undefined> = []
  return {
    unsaved,
    asked,
    persisted,
    ask: async (routes) => {
      asked.push([...routes])
      return answer === 'yes' ? mintHumanApproval(routes) : undefined
    },
    persist: async (approval) => { persisted.push(approval) },
  }
}

const signal = new AbortController().signal

describe('SubagentModelSelectionConfig.widenSession', () => {
  it('allows a newly approved route in the same Session and records one setup entry', async () => {
    const { ctx, policy, create } = await boot()
    const agent = await create()
    expect(await blocked(ctx, agent, B)).toBe(true)
    const recorded = steps('yes')

    expect(await ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal))
      .toEqual({ kind: 'widened', revision: 2 })

    expect(recorded.asked).toEqual([[B]])
    expect(recorded.persisted).toHaveLength(1)
    expect(await blocked(ctx, agent, B)).toBe(false)
    expect(await blocked(ctx, agent, C)).toBe(true)
    expect(sessionPolicy(policy, agent.session)).toEqual({ revision: 2, routes: [A, B] })
    expect(entries(agent).map(event => event.data)).toEqual([
      { allowedModels: [A] },
      { allowedModels: [A, B], origin: 'setup', revision: 2 },
    ])
  })

  it('saves nothing and appends nothing after a decline', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const recorded = steps('no')

    expect(await ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal)).toEqual({ kind: 'declined' })

    expect(recorded.persisted).toEqual([])
    expect(entries(agent)).toHaveLength(1)
    expect(await blocked(ctx, agent, B)).toBe(true)
  })

  it('appends nothing when persisting fails, and asks again on retry', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const recorded = steps('yes')
    let failing = true
    const persist = vi.fn(async (approval: HumanApproval | undefined) => {
      if (failing) throw new Error('disk full')
      await recorded.persist(approval)
    })

    await expect(ctx.subagentModelSelection.widenSession(agent, [A, B], { ...recorded, persist }, signal))
      .rejects.toThrow('disk full')
    expect(entries(agent)).toHaveLength(1)

    failing = false
    await ctx.subagentModelSelection.widenSession(agent, [A, B], { ...recorded, persist }, signal)
    expect(recorded.asked).toEqual([[B], [B]])
    expect(entries(agent)).toHaveLength(2)
  })

  it('recovers from a crash after persisting and before the append without duplicating entries', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const recorded = steps('yes')
    const append = vi.spyOn(agent.session, 'append').mockImplementationOnce(() => { throw new Error('crashed before append') })

    await expect(ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal))
      .rejects.toThrow('crashed before append')
    expect(recorded.persisted).toHaveLength(1)
    expect(await blocked(ctx, agent, B)).toBe(true)
    append.mockRestore()

    expect(await ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal))
      .toEqual({ kind: 'widened', revision: 2 })
    expect(recorded.asked).toEqual([[B], [B]])
    expect(entries(agent)).toHaveLength(2)
    expect(await blocked(ctx, agent, B)).toBe(false)
  })

  it('is idempotent: the second identical request asks nothing and appends nothing', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const recorded = steps('yes')
    await ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal)

    expect(await ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal))
      .toEqual({ kind: 'unchanged', revision: 2 })

    expect(recorded.asked).toEqual([[B]])
    expect(recorded.persisted).toEqual([expect.anything(), undefined])
    expect(entries(agent)).toHaveLength(2)
  })

  it('asks for routes the Session has but the caller has not saved, without appending', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const recorded = steps('yes', [A])

    expect(await ctx.subagentModelSelection.widenSession(agent, [A], recorded, signal))
      .toEqual({ kind: 'unchanged', revision: 1 })

    expect(recorded.asked).toEqual([[A]])
    expect(entries(agent)).toHaveLength(1)
  })

  it('declines unsaved-only routes without saving', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const recorded = steps('no', [A])
    expect(await ctx.subagentModelSelection.widenSession(agent, [A], recorded, signal)).toEqual({ kind: 'declined' })
    expect(recorded.persisted).toEqual([])
  })

  it('rejects a proof that does not cover every route that needs confirmation', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const recorded = { ...steps('yes'), ask: async () => mintHumanApproval([C]) }

    await expect(ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal))
      .rejects.toThrow('does not cover every route')
    expect(recorded.persisted).toEqual([])
    expect(entries(agent)).toHaveLength(1)
  })

  it('rejects a structurally forged proof before persisting or appending', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const forged = { routes: [A, B] } as HumanApproval
    const recorded = { ...steps('yes'), ask: async () => forged }

    await expect(ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal))
      .rejects.toThrow('human approval')
    expect(recorded.persisted).toEqual([])
    expect(entries(agent)).toHaveLength(1)
  })

  it('lets only children created after the widening inherit it', async () => {
    const { ctx, policy, create } = await boot()
    const parent = await create()
    const early = await create(parent)
    await ctx.subagentModelSelection.widenSession(parent, [A, B], steps('yes'), signal)
    const late = await create(parent)

    expect(sessionPolicy(policy, early.session)?.routes).toEqual([A])
    expect(sessionPolicy(policy, late.session)?.routes).toEqual([A, B])
  })

  it('keeps the parent route when widening a Session that began without a policy', async () => {
    const { ctx, policy, create } = await boot(null)
    const agent = await create(undefined, { provider: 'parent-provider', model: 'parent-model' })
    expect(sessionPolicy(policy, agent.session)).toBeUndefined()
    const parentRoute = { provider: 'parent-provider', model: 'parent-model' }
    const recorded = steps('yes')

    expect(await ctx.subagentModelSelection.widenSession(agent, [B], recorded, signal))
      .toEqual({ kind: 'widened', revision: 1 })

    expect(recorded.asked).toEqual([[B]])
    expect(sessionPolicy(policy, agent.session)).toEqual({ revision: 1, routes: [parentRoute, B] })
    expect(await blocked(ctx, agent, parentRoute)).toBe(false)
    expect(await blocked(ctx, agent, B)).toBe(false)
  })

  it('treats the parent route of a policy-less Session as already allowed', async () => {
    const { ctx, create } = await boot(null)
    const agent = await create(undefined, { provider: 'parent-provider', model: 'parent-model' })
    const recorded = steps('yes')
    expect(await ctx.subagentModelSelection.widenSession(
      agent, [{ provider: 'parent-provider', model: 'parent-model' }], recorded, signal,
    )).toEqual({ kind: 'unchanged', revision: undefined })
    expect(recorded.asked).toEqual([])
    expect(entries(agent)).toHaveLength(0)
  })

  it('refuses to widen a policy-less Session whose parent route is unknown', async () => {
    const { ctx, create } = await boot(null)
    const agent = await create()
    const recorded = steps('yes')

    await expect(ctx.subagentModelSelection.widenSession(agent, [B], recorded, signal))
      .rejects.toThrow('parent provider and model are unknown')
    expect(recorded.asked).toEqual([])
  })

  it('refuses to widen when the operator disables model selection', async () => {
    const { ctx, create, config } = await boot()
    const agent = await create()
    await config.update({ enabled: false })
    const recorded = steps('yes')

    await expect(ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, signal))
      .rejects.toThrow('disabled by the operator')
    expect(recorded.asked).toEqual([])
  })

  it('stops after the answer when the signal aborts, appending nothing', async () => {
    const { ctx, create } = await boot()
    const agent = await create()
    const controller = new AbortController()
    const recorded = { ...steps('yes'), ask: async (routes: readonly AllowedModelRoute[]) => {
      controller.abort(new Error('cancelled'))
      return mintHumanApproval(routes)
    } }
    await expect(ctx.subagentModelSelection.widenSession(agent, [A, B], recorded, controller.signal))
      .rejects.toThrow('cancelled')
    expect(recorded.persisted).toEqual([])
    expect(entries(agent)).toHaveLength(1)
  })

  it('serializes two parallel widenings into consecutive revisions without gaps or duplicates', async () => {
    const { ctx, policy, create } = await boot()
    const agent = await create()
    const results = await Promise.all([
      ctx.subagentModelSelection.widenSession(agent, [A, B], steps('yes'), signal),
      ctx.subagentModelSelection.widenSession(agent, [A, C], steps('yes'), signal),
    ])

    expect(results.map(result => result.kind)).toEqual(['widened', 'widened'])
    expect(entries(agent).map(event => event.data.revision ?? 1)).toEqual([1, 2, 3])
    expect(sessionPolicy(policy, agent.session)?.routes).toEqual([A, B, C])
  })
})
