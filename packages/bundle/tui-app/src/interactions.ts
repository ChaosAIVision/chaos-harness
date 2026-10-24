/** Exact scoped Remote waterfall consumers for terminal questions and approvals. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type { TypertClientEventListener } from '@deepseek-ai/dsh-typert-protocol'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { conversationText as t } from './conversation-locales.ts'
import type { TerminalPresentation } from './types.ts'

type QuestionListener = TypertClientEventListener<'user-questions/request'>
type ApprovalListener = TypertClientEventListener<'approval/request'>
type QuestionRequest = Parameters<QuestionListener>[0]

/** Wire-preserved errors understood by the Host user-questions service. */
export class TerminalQuestionError extends Error {
  override readonly name = 'UserQuestionError'
  constructor(readonly code: 'ASK_CANCELLED' | 'ASK_ABORTED' | 'ASK_TIMED_OUT') {
    super(code === 'ASK_TIMED_OUT' ? t.questionTimedOut : code === 'ASK_ABORTED' ? t.questionAborted : t.questionCancelled)
  }
}

const questionSchema = z.object({
  id: z.string(), question: z.string(), detail: z.string().optional(), header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  intent: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('plan-review'), approve: z.string() }),
    z.object({ kind: z.literal('approval'), approve: z.string(), reject: z.string(), always: z.string().optional() }),
  ]).optional(),
}).transform((question): AskUserQuestionItem => ({
  id: question.id, question: question.question,
  ...(question.detail === undefined ? {} : { detail: question.detail }),
  ...(question.header === undefined ? {} : { header: question.header }),
  ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
  ...(question.options === undefined ? {} : { options: question.options.map(option => ({ label: option.label,
    ...(option.description === undefined ? {} : { description: option.description }) })) }),
  ...(question.intent === undefined ? {} : { intent: question.intent.kind === 'plan-review' ? question.intent : {
    kind: question.intent.kind, approve: question.intent.approve, reject: question.intent.reject,
    ...(question.intent.always === undefined ? {} : { always: question.intent.always }),
  } }),
}))
const projectionSchema = z.object({ active: z.array(z.object({ callId: z.string(), state: z.enum(['open', 'continued']),
  questions: z.array(questionSchema) })) })

/**
 * Collect one complete answer batch, preserving caller-declared labels and intent.
 * @param questions - exact request's questions.
 * @param view - presentation bound to that request's cancellation.
 * @param signal - request lifetime checked before every answer is returned.
 * @returns one answer per caller-provided question id.
 */
export async function collectQuestionAnswers(questions: readonly AskUserQuestionItem[], view: TerminalPresentation,
  signal: AbortSignal): Promise<AskUserQuestionAnswer> {
  const answers: AskUserQuestionAnswerItem[] = []
  const cancelled = (): never => { throw new TerminalQuestionError(signal.aborted ? 'ASK_ABORTED' : 'ASK_CANCELLED') }
  for (const question of questions) {
    if (signal.aborted) cancelled()
    const title = question.header ? `${question.header} · ${question.question}` : question.question
    if (question.detail) await view.show(title, question.detail)
    if (signal.aborted) cancelled()
    const selected: string[] = []
    let custom: string | undefined
    if (question.options?.length) {
      let finished = false
      while (!finished) {
        const choices = question.options.map(option => ({
          label: `${question.multiSelect && selected.includes(option.label) ? '✓ ' : ''}${option.label}`,
          ...(option.description === undefined ? {} : { description: option.description }),
          value: { kind: 'option' as const, label: option.label },
        }))
        const actions = [
          ...choices,
          ...(question.intent?.kind === 'approval' ? [] : [{ label: t.other, value: { kind: 'other' as const } }]),
          ...(question.multiSelect ? [{ label: t.done, value: { kind: 'done' as const } }] : []),
        ]
        const choice = await view.choose<{ kind: 'option'; label: string } | { kind: 'other' } | { kind: 'done' }>(title, actions)
        if (choice === undefined || signal.aborted) return cancelled()
        if (choice.kind === 'option') {
          if (question.multiSelect) {
            const index = selected.indexOf(choice.label)
            if (index < 0) selected.push(choice.label)
            else selected.splice(index, 1)
          } else { selected.push(choice.label); finished = true }
        } else if (choice.kind === 'done') finished = true
        else {
          custom = await view.input(title)
          if (custom === undefined || signal.aborted) cancelled()
          finished = true
        }
      }
    } else {
      custom = await view.input(title)
      if (custom === undefined || signal.aborted) cancelled()
    }
    answers.push({ id: question.id, selected, ...(custom === undefined ? {} : { custom }) })
  }
  if (signal.aborted) cancelled()
  return { answers }
}

/** Terminal interaction registry, installed before any Session can submit its first prompt. */
export class TerminalInteractions {
  private readonly lifetime = new AbortController()
  private readonly disposeListeners: (() => void)[]

  constructor(private readonly client: Context, private readonly presentation: (signal: AbortSignal) => TerminalPresentation,
    private readonly appSignal: AbortSignal) {
    const answerApproval = this.answerApproval.bind(this)
    const answerQuestion = this.answerQuestion.bind(this)
    this.disposeListeners = [
      client.remote.$on('approval/request', function (request, next) {
        const session = client.sessions.sessionOf(this)
        return session === undefined ? next() : answerApproval(request, session.sessionId)
      }),
      client.remote.$on('user-questions/request', function (request, next) {
        const session = client.sessions.sessionOf(this)
        return session === undefined ? next() : answerQuestion(request, session.sessionId, next)
      }),
    ]
  }

  /** Withdraw presentations and unregister the exact Remote listeners. */
  dispose(): void {
    this.lifetime.abort()
    for (const dispose of this.disposeListeners) dispose()
  }

  private signal(requestSignal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.lifetime.signal, this.appSignal, ...(requestSignal === undefined ? [] : [requestSignal])])
  }

  private viewFor(signal: AbortSignal, sessionId: string): TerminalPresentation {
    const view = this.presentation(signal)
    return {
      choose: (title, choices) => view.choose(`${sessionId} · ${title}`, choices),
      input: (title, options) => view.input(`${sessionId} · ${title}`, options),
      show: (title, text) => view.show(`${sessionId} · ${title}`, text),
      terminal: (title, run) => view.terminal(`${sessionId} · ${title}`, run),
    }
  }

  private async answerApproval(
    request: Parameters<ApprovalListener>[0], sessionId: string,
  ): Promise<Awaited<ReturnType<ApprovalListener>>> {
    const signal = this.signal(request.signal)
    const view = this.viewFor(signal, sessionId)
    const answer = await view.choose(`${t.approval} · ${request.toolName}`, [
      { label: t.allow, ...(request.displayReason?.en ?? request.reason) === undefined ? {} : {
        description: request.displayReason?.en ?? request.reason }, value: 'allowed-once' as const },
      { label: t.reject, value: 'rejected' as const },
    ])
    return signal.aborted ? 'cancelled' : answer ?? 'rejected'
  }

  private async answerQuestion(request: QuestionRequest, sessionId: Parameters<Context['sessions']['binding']>[0],
    next: Parameters<QuestionListener>[1]): Promise<AskUserQuestionAnswer> {
    const controller = new AbortController()
    const signal = AbortSignal.any([this.signal(request.signal), controller.signal])
    const claim = request.wait?.timed === true
      ? this.client.remote.userQuestions.attachWait(sessionId, request.wait.callId, signal) : undefined
    const iterator = claim?.[Symbol.asyncIterator]()
    let timer: ReturnType<typeof setTimeout> | undefined
    let afterAnswer: Promise<unknown> | undefined
    let answered = false
    try {
      const opening = await iterator?.next()
      if (opening?.done === true) return await next()
      const expired = Promise.withResolvers<never>()
      if (opening !== undefined) timer = setTimeout(() => {
        expired.reject(new TerminalQuestionError('ASK_TIMED_OUT'))
        controller.abort()
      }, opening.value.remainingMs)
      const claimEnded = iterator === undefined ? undefined : iterator.next()
      afterAnswer = claimEnded
      const answer = collectQuestionAnswers(request.questions, this.viewFor(signal, sessionId), signal)
      const outcome = claimEnded === undefined ? answer : Promise.race([answer, expired.promise, claimEnded.then(() => {
        throw new TerminalQuestionError('ASK_ABORTED')
      })])
      const result = await outcome
      if (signal.aborted) throw new TerminalQuestionError('ASK_ABORTED')
      answered = true
      return result
    } finally {
      clearTimeout(timer)
      if (answered && afterAnswer !== undefined) {
        // Keep the claim until the Host receives the answer and closes its wait.
        void afterAnswer.finally(() => { controller.abort(); claim?.dispose() }).catch(() => undefined)
      } else { controller.abort(); claim?.dispose() }
    }
  }

  /**
   * Answer a continued question through its exact Host call identity.
   * @param session - currently retained Session face.
   * @returns completion, with stale replies reported as failures.
   */
  async answerContinued(session: NonNullable<ReturnType<Context['sessions']['sessionOf']>>): Promise<void> {
    const signal = this.signal()
    const value = session.projections.faceOf('userQuestions').getSnapshot()
    if (value === undefined) throw new Error(t.questionUnavailable)
    const projection = projectionSchema.parse(value)
    const active = projection.active.filter(question => question.state === 'continued')
    const view = this.viewFor(signal, session.sessionId)
    const selected = await view.choose(t.lateQuestions, active.map(question => ({
      label: question.questions.map(item => item.question).join(' · '), value: question,
    })))
    if (selected === undefined) return
    const answers = await collectQuestionAnswers(selected.questions, view, signal)
    const current = projectionSchema.parse(session.projections.faceOf('userQuestions').getSnapshot() ?? { active: [] })
    const pending = current.active.find(question => question.callId === selected.callId && question.state === 'continued')
    if (pending === undefined) throw new Error(t.questionUnavailable)
    const result = await this.client.remote.userQuestions.answer(session.sessionId, brandString<ToolCallId>(pending.callId), answers)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    if (!result.value) throw new Error(t.questionUnavailable)
  }
}
