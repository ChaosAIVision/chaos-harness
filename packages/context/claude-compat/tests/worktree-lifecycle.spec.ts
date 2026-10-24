/** Optional worktree service lifecycle through the real compat adapter and tool registry. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Skills from '@deepseek-ai/dsh-skill'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { afterEach, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { git, repository, UnusedSandbox } from '../../../experimental/worktree/tests/harness.ts'
import Worktrees from '../../../experimental/worktree/src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'
import * as compat from '../src/index.ts'

let ctx: Context | undefined
let temporary = ''
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.unstubAllEnvs()
  if (temporary) await rm(temporary, { recursive: true, force: true })
})

it('refreshes only claude_agent when worktrees are added, removed, and replaced, and denies an admitted stale tool', async () => {
  temporary = await mkdtemp(join(tmpdir(), 'compat-worktree-hmr-'))
  const root = await repository(temporary)
  vi.stubEnv('DSH_HOME', join(temporary, 'home'))
  vi.stubEnv('DSH_AGENTS_HOME', join(temporary, 'agents'))
  ctx = new Context()
  const context = ctx
  await mountAgentLoopTestDependencies(context, { workingDirectory: true })
  await context.plugin(JsonlPersistence, { root: join(temporary, 'sessions'), compression: 'none' })
  await context.plugin(AgentLoop, { agents: [] })
  await context.plugin(LocalSubprocess)
  await context.plugin(UnusedSandbox)
  await context.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: root })
  await liveConfig(context, Subagents)
  await context.plugin(Spawn, { providerName: 'spawn' })
  context.llm.registerAdapter(['mock'], new MockAdapter(Array.from({ length: 12 }, () => textResponse('LIFECYCLE_DONE'))))
  await context.plugin(Skills)
  const compatibility = await context.plugin(compat, { roots: [], provider: 'spawn', models: {}, modelAliases: {}, modelSelection: false, hooks: false })
  const { agent } = await context.agents.create({ sessionId: SessionId('hmr-parent'), agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  const current = () => {
    const tool = context.tools.get('claude_agent', agent)
    if (tool === undefined) throw new Error('missing claude_agent')
    return tool
  }
  const models = context.tools.get('claude_agent_models', agent)
  const schema = () => current().parameters as { properties?: Record<string, unknown> }
  const input = () => ({ name: 'claude_agent', callId: ToolCallId(`call-${Math.random()}`), arguments: { description: 'lifecycle probe', prompt: 'Reply DONE', isolation: 'worktree' }, agent, signal: new AbortController().signal })
  expect(schema().properties).not.toHaveProperty('isolation')
  expect((await executeToolFixture(context, input())).isError).toBe(true)

  const first = await context.plugin(Worktrees, { directory: '.leases-a', baseRef: 'head' })
  expect(schema().properties).toHaveProperty('isolation')
  const started = await executeToolFixture(context, input())
  expect(started.isError).toBe(false)
  expect(JSON.stringify(started.content)).toContain('.leases-a')
  await vi.waitFor(async () => { expect(await context.worktrees.list(agent)).toEqual([]) })
  const pipeline = new ToolExecutionPipeline(context)
  const admitted = await pipeline.prepare(input())
  if (admitted.kind !== 'dispatch') throw new Error('expected admitted worktree dispatch')

  await first.dispose()
  expect(schema().properties).not.toHaveProperty('isolation')
  const denied = await pipeline.dispatch(admitted.exec)
  const result = await pipeline.complete(admitted.exec, denied)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('requires the worktree service')
  expect(context.tools.get('claude_agent_models', agent)).toBe(models)

  const replacement = await context.plugin(Worktrees, { directory: '.leases-b', baseRef: 'head' })
  expect(schema().properties).toHaveProperty('isolation')
  const restarted = await executeToolFixture(context, input())
  expect(restarted.isError).toBe(false)
  expect(JSON.stringify(restarted.content)).toContain('.leases-b')
  await vi.waitFor(async () => { expect(await context.worktrees.list(agent)).toEqual([]) })
  expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toBe('')
  expect(context.tools.get('claude_agent_models', agent)).toBe(models)
  await replacement.dispose()
  expect(schema().properties).not.toHaveProperty('isolation')
  await compatibility.dispose()
  expect(context.tools.get('claude_agent', agent)).toBeUndefined()
  expect(context.tools.get('claude_agent_models', agent)).toBeUndefined()
  await context.plugin(Worktrees, { directory: '.leases-c', baseRef: 'head' })
  expect(context.tools.get('claude_agent', agent)).toBeUndefined()
}, 20_000)
