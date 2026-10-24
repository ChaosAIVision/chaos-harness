/** Evidence for the two runtime assumptions behind the widening policy log. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import '../src/model-selection-state.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ownContext } from './harness.ts'

interface Route { provider: string; model: string }
const stub = { provider: 'alpha', model: 'fast-model' }

const KEY = 'subagentModelSelectionPolicy'
const v1 = {
  key: KEY,
  stateVersion: 1,
  stateSchema: zod.array(zod.object({ provider: zod.string(), model: zod.string() })).nullable(),
  init: () => null as Route[] | null,
  apply: (state, event) => state !== null || event.type !== 'subagent/model-selection-policy' ? state : event.data.allowedModels,
} satisfies ProjectionDefinition<typeof KEY, Route[] | null>

interface Policy { revision: number; routes: Route[] }
const v2 = {
  key: KEY,
  stateVersion: 2,
  stateSchema: zod.object({
    revision: zod.number(),
    routes: zod.array(zod.object({ provider: zod.string(), model: zod.string() })),
  }).nullable(),
  init: () => null as Policy | null,
  apply: (state, event) => {
    if (event.type !== 'subagent/model-selection-policy') return state
    const data = event.data as { allowedModels: Route[]; revision?: number; origin?: string }
    if (state === null) return { revision: data.revision ?? 1, routes: data.allowedModels }
    return data.origin === 'setup' && data.revision === state.revision + 1
      ? { revision: data.revision, routes: data.allowedModels }
      : state
  },
} satisfies ProjectionDefinition<typeof KEY, Policy | null>

describe('spike 1: stateVersion bump rebuilds the projection from the log', () => {
  it('discards a version-1 checkpoint row and refolds the full log under version 2', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    const handle = await ctx.sessionProjections.register(v2)
    const session = Session.create(SessionId('spike-1'))
    session.append('subagent/model-selection-policy', { allowedModels: [stub] })
    session.append('subagent/model-selection-policy', {
      allowedModels: [stub, { provider: 'beta', model: 'x' }], origin: 'setup', revision: 2,
    } as never)

    const stale = { [KEY]: { ver: v1.stateVersion, seq: 1, val: [stub] } }
    const restored = ctx.sessionProjections.restore(
      stale, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount,
    )
    expect(restored.checkpoint[KEY]).toMatchObject({ ver: 2, val: { revision: 2, routes: [stub, { provider: 'beta', model: 'x' }] } })
    expect(handle.stateOf(session)).toMatchObject({ revision: 2 })
  })

  it('refuses to restore a version-mismatched row from a partial tail', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.sessionProjections.register(v2)
    const session = Session.create(SessionId('spike-1-tail'))
    session.append('subagent/model-selection-policy', { allowedModels: [stub] })
    session.append('subagent/model-selection-policy', { allowedModels: [stub] })
    const tail = session.snapshotEvents().slice(1)
    expect(() => ctx.sessionProjections.restore(
      { [KEY]: { ver: 1, seq: 0, val: [stub] } }, tail, SessionLogOffset(1), session.header, session.inheritedEventCount,
    )).toThrow('re-read from seq 0')
  })
})

describe('spike 2: session.append from inside a running tool call', () => {
  it('commits between the call and its result and is visible to the next step and sibling calls', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    const handle = await ctx.sessionProjections.register(v2)
    await ctx.plugin(AgentLoop, { agents: [] })
    const seen: Array<number | undefined> = []
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'widen', { revision: 2 }),
      toolCallResponse('c2', 'peek', {}),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('spike-2'), { provider: 'mock', model: 'mock' })
    agent.session.append('subagent/model-selection-policy', { allowedModels: [stub] })
    ctx.tools.register(defineContentToolFixture({
      name: 'widen', description: 'append', parameters: { revision: { type: 'number', required: true } },
      async execute(args, exec) {
        await new Promise(resolve => setTimeout(resolve, 5))
        exec.agent!.session.append('subagent/model-selection-policy', {
          allowedModels: [stub, { provider: 'beta', model: 'x' }], origin: 'setup', revision: args.revision,
        } as never)
        seen.push(handle.stateOf(exec.agent!.session)?.revision)
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'peek', description: 'read', parameters: {},
      async execute(_args, exec) {
        seen.push(handle.stateOf(exec.agent!.session)?.revision)
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    const idle = new Promise<void>((resolve) => { const off = ctx.on('agent/status', ({ agent: a, status }) => { if (a === agent && status === 'idle') { off(); resolve() } }) })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    expect(seen).toEqual([2, 2])
    const order = agent.session.snapshotEvents().map(event => event.type).filter(type => ['tool/call', 'subagent/model-selection-policy', 'tool/result'].includes(type))
    expect(order).toEqual(['subagent/model-selection-policy', 'tool/call', 'subagent/model-selection-policy', 'tool/result', 'tool/call', 'tool/result'])
  })
})

describe('spike 3: a role sheet injected from a tool call', () => {
  it('is logged and reaches the next model request after the tool result', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'sheet', {}), textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('spike-3'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'sheet', description: 'inject', parameters: {},
      async execute(_args, exec) {
        exec.agent!.inject(createUserMessage({ content: [{ type: 'text', text: 'pstack role sheet d41f9a2c' }], source: { kind: 'hooks-claude-code' } }))
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    const idle = new Promise<void>((resolve) => { const off = ctx.on('agent/status', ({ agent: a, status }) => { if (a === agent && status === 'idle') { off(); resolve() } }) })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle

    const second = JSON.stringify(adapter.requests[1]?.messages)
    expect(second.indexOf('"ok"')).toBeGreaterThan(-1)
    expect(second.indexOf('pstack role sheet d41f9a2c')).toBeGreaterThan(second.indexOf('"ok"'))
    expect(agent.session.snapshotEvents().some(event => JSON.stringify(event).includes('pstack role sheet d41f9a2c'))).toBe(true)
  })
})
