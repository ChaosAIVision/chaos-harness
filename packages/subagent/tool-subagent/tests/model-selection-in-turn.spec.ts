/** Runtime assumptions behind the widening policy log: append and inject from inside a running tool call. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { sessionPolicy, subagentModelSelectionProjectionDefinition } from '../src/model-selection-state.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ownContext } from './harness.ts'

const stub = { provider: 'alpha', model: 'fast-model' }

describe('session.append from inside a running tool call', () => {
  it('commits between the call and its result and is visible to the next step and sibling calls', async () => {
    const ctx = ownContext(new Context())
    await mountAgentLoopTestDependencies(ctx)
    const handle = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
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
        })
        seen.push(sessionPolicy(handle, exec.agent!.session)?.revision)
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'peek', description: 'read', parameters: {},
      async execute(_args, exec) {
        seen.push(sessionPolicy(handle, exec.agent!.session)?.revision)
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

describe('a role sheet injected from a tool call', () => {
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
