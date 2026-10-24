/** Scoped Remote listeners tested with the Host's actual timed-wait implementation. */
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { TimedQuestionWait } from '../../../interaction/user-questions/src/timed-wait.ts'
import { TerminalInteractions } from '../src/interactions.ts'
import type { TerminalChoice, TerminalPresentation } from '../src/types.ts'

type Listeners = {
  'approval/request': TypertClientEventListener<'approval/request'>
  'user-questions/request': TypertClientEventListener<'user-questions/request'>
}

async function fixture(view: TerminalPresentation, duration = 1000) {
  const root = new Context()
  const scope = createScope(root, SessionId('interaction'))
  const listeners: Partial<Listeners> = {}
  const app = new AbortController()
  const wait = new TimedQuestionWait(Date.now() + duration, undefined, new Error('Host timeout'))
  let claimsDisposed = 0
  Object.defineProperty(root, 'remote', { value: {
    $on<E extends keyof Listeners>(event: E, listener: Listeners[E]): () => void {
      listeners[event] = listener
      return () => {
        if (event === 'approval/request') delete listeners['approval/request']
        else delete listeners['user-questions/request']
      }
    },
    userQuestions: {
      attachWait(_sessionId: string, _callId: string, signal: AbortSignal) {
        const controller = new AbortController()
        const stream = wait.attach(AbortSignal.any([signal, controller.signal]))
        return Object.assign(stream, { dispose: () => { claimsDisposed += 1; controller.abort() } })
      },
    },
  } })
  Object.defineProperty(root, 'sessions', { value: {
    sessionOf: (owner: Context) => owner === scope.ctx ? { sessionId: SessionId('interaction') } : undefined,
  } })
  const interactions = new TerminalInteractions(root, () => view, app.signal)
  const question = listeners['user-questions/request']
  const approval = listeners['approval/request']
  if (question === undefined || approval === undefined) throw new Error('Interaction listeners were not installed')
  return {
    root, scope, listeners, question, approval, wait,
    disposed: () => claimsDisposed,
    close: async () => { interactions.dispose(); wait.close(undefined); await root.fiber.dispose() },
  }
}

class ChoiceView implements TerminalPresentation {
  constructor(private readonly index?: number) {}
  async choose<T>(_title: string, choices: readonly TerminalChoice<T>[]): Promise<T | undefined> {
    return this.index === undefined ? undefined : choices[this.index]?.value
  }
  async input(): Promise<undefined> { return undefined }
  async show(): Promise<void> {}
  async terminal(): Promise<void> {}
}

describe('terminal Remote interactions', () => {
  it('delegates a request whose scoped generation is not retained', async () => {
    const f = await fixture(new ChoiceView(0))
    try {
      let delegated = false
      const answer = { answers: [] }
      expect(await f.question.call(f.root, { questions: [] }, async () => { delegated = true; return answer })).toBe(answer)
      expect(delegated).toBe(true)
    } finally { await f.close() }
    expect(Object.keys(f.listeners)).toEqual([])
  })

  it('fails approvals closed on Escape and returns a one-shot grant only for explicit Allow', async () => {
    for (const index of [undefined, 0, 1]) {
      const f = await fixture(new ChoiceView(index))
      try {
        expect(await f.approval.call(f.scope.ctx, { agent: f.scope.ctx, toolName: 'shell' }, async () => 'unavailable'))
          .toBe(index === 0 ? 'allowed-once' : 'rejected')
      } finally { await f.close() }
    }
  })

  it('keeps a foreground claim until the Host accepts the exact answer', async () => {
    const f = await fixture(new ChoiceView(1))
    try {
      const answer = await f.question.call(f.scope.ctx, {
        questions: [{ id: 'setup', question: 'Set up?', options: [{ label: 'Set up' }, { label: 'Keep current' }] }],
        wait: { callId: ToolCallId('setup'), timed: true },
      }, async () => ({ answers: [] }))
      expect(answer).toEqual({ answers: [{ id: 'setup', selected: ['Keep current'] }] })
      expect(f.disposed()).toBe(0)
      f.wait.close(undefined)
      await new Promise(resolve => setImmediate(resolve))
      expect(f.disposed()).toBe(1)
    } finally { await f.close() }
  })

  it('returns the Host timeout code when an unanswered claimed question expires', async () => {
    const view: TerminalPresentation = {
      choose: () => new Promise(() => undefined), input: () => new Promise(() => undefined),
      show: async () => undefined, terminal: async () => undefined,
    }
    const f = await fixture(view, 30)
    try {
      await expect(f.question.call(f.scope.ctx, { questions: [{ id: 'wait', question: 'Waiting' }],
        wait: { callId: ToolCallId('wait'), timed: true } }, async () => ({ answers: [] })))
        .rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_TIMED_OUT' })
      expect(f.disposed()).toBe(1)
    } finally { await f.close() }
  })
})
