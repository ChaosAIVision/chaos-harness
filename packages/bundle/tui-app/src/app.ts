/** Conversation lifecycle over existing Client Sessions and generated Remote APIs. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionBinding, SessionFace, SessionReference, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { TerminalCatalog } from './catalog.ts'
import { conversationText as t } from './conversation-locales.ts'
import { handleTerminalFeature, terminalFeatureCommands } from './features.ts'
import { TerminalInteractions } from './interactions.ts'
import { TerminalRenderer } from './renderer.ts'
import { transcriptRows, windowUsage } from './transcript.ts'
import type { TerminalAppOptions, TerminalFeatureHost } from './types.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The terminal's selected conversation. */
    terminalConversation: unknown
  }
}

const queuedMessage = z.object({
  id: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
})
const inboxSchema = z.object({ 'next-turn': z.array(queuedMessage), 'next-step': z.array(queuedMessage) })
const modelSchema = z.object({
  next: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }).nullable(),
})

function accepted<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

class Conversation {
  private reference: SessionReference | undefined
  private unsubscribe: (() => void)[] = []
  private selection = 0
  private mode: 'queue' | 'steer' = 'queue'
  private defaultModel = ''
  private readonly connection: ConnectionHandle
  readonly renderer: TerminalRenderer
  readonly interactions: TerminalInteractions
  private readonly catalog: TerminalCatalog
  readonly host: TerminalFeatureHost

  constructor(private readonly client: Context, private readonly options: TerminalAppOptions,
    private readonly quit: () => void) {
    this.connection = client.get('connection') as ConnectionHandle
    this.renderer = new TerminalRenderer({
      submit: (text) => { this.perform(() => this.submit(text).finally(() => { this.renderer.submissionFinished() })) },
      cancel: () => { this.perform(async () => { accepted(await this.required().cancel()) }) },
      quit,
      older: () => { this.perform(async () => { await this.required().loadOlder() }) },
    })
    this.interactions = new TerminalInteractions(client, signal => this.renderer.scoped(signal), options.signal)
    this.catalog = new TerminalCatalog(client, terminalFeatureCommands)
    this.renderer.setAutocomplete(this.catalog.provider(options.cwd, options.signal, error => this.failure(error)))
    this.host = {
      client, signal: options.signal, view: this.renderer.scoped(options.signal),
      request: (path, init) => client.terminalRequests.fetch(path, init),
      current: () => this.reference?.binding.session,
      select: target => this.select(target),
    }
  }

  private perform(operation: () => Promise<void>): void {
    void operation().catch((error) => { if (!this.options.signal.aborted) this.failure(error) })
  }

  private failure(error: unknown): void {
    this.renderer.notice(`${t.failed} · ${error instanceof Error ? error.message : String(error)}`)
  }

  private required(): SessionFace {
    const session = this.reference?.binding.session
    if (session === undefined) throw new Error(t.noSession)
    return session
  }

  async open(): Promise<void> {
    this.renderer.start()
    this.unsubscribe.push(this.client.sessions.list.subscribe(() => this.update()))
    this.unsubscribe.push(this.connection.state.subscribe(() => this.update()))
    this.unsubscribe.push(this.client.remote.$on('commands/change', () => {
      const session = this.reference?.binding.session
      if (session !== undefined) this.perform(() => this.catalog.refresh(session.sessionId, this.options.signal))
    }))
    this.unsubscribe.push(this.client.remote.$on('agent-preset/selected', (sessionId) => {
      if (sessionId === this.reference?.sessionId) this.perform(() => this.catalog.refresh(sessionId, this.options.signal))
    }))
    await this.waitForConnection()
    switch (this.options.initial.kind) {
      case 'session': await this.select(this.options.initial.sessionId); break
      case 'picker': await this.picker(); break
      case 'new': await this.create(this.options.initial.preset); break
    }
    this.update()
  }

  private async waitForConnection(): Promise<void> {
    this.renderer.notice(t.connecting)
    const ready = Promise.withResolvers<void>()
    const check = (): void => {
      if (this.connection.generation.getSnapshot() !== undefined) ready.resolve()
    }
    const abort = (): void => { ready.reject(this.options.signal.reason) }
    const unsubscribe = this.connection.generation.subscribe(check)
    this.options.signal.addEventListener('abort', abort, { once: true })
    try {
      this.options.signal.throwIfAborted()
      check()
      await ready.promise
      this.renderer.notice('')
    } finally {
      unsubscribe()
      this.options.signal.removeEventListener('abort', abort)
    }
  }

  private async create(preset?: string): Promise<void> {
    const id = await this.client.sessions.create({ cwd: this.options.cwd, ...(preset === undefined ? {} : { agentPreset: preset }) })
    await this.select(id)
  }

  private async select(target: SessionTarget): Promise<void> {
    const selection = ++this.selection
    const reference = this.client.sessions.retain(target, { source: 'terminalConversation', signal: this.options.signal })
    let binding: SessionBinding
    try {
      binding = await reference.ready
      const snapshot = binding.session.getSnapshot()
      if (snapshot.openState !== 'open') throw new Error(snapshot.openError?.message ?? t.openFailed)
      if (selection !== this.selection || this.options.signal.aborted) { reference.release(); return }
    } catch (error) { reference.release(); throw error }
    const previous = this.reference
    for (const dispose of this.sessionSubscriptions) dispose()
    this.reference = reference
    this.sessionSubscriptions = [binding.session.subscribe(() => this.update()), binding.eventSource.subscribe(() => this.update()),
      binding.session.projections.faceOf('modelSelection').subscribe(() => this.update()),
      binding.session.projections.faceOf('inbox').subscribe(() => this.update())]
    previous?.release()
    this.renderer.editor.setText('')
    this.update()
    const refreshed = await Promise.allSettled([
      this.catalog.refresh(binding.sessionId, this.options.signal),
      this.client.remote.session.modelCatalog().then((result) => {
        const catalog = accepted(result)
        this.defaultModel = `${catalog.default.provider}/${catalog.default.model}`
        this.update()
      }),
    ])
    for (const result of refreshed) if (result.status === 'rejected') this.failure(result.reason)
  }

  private sessionSubscriptions: (() => void)[] = []

  private update(): void {
    const binding = this.reference?.binding
    if (binding === undefined) return
    const snapshot = binding.session.getSnapshot()
    const entries = binding.eventSource.getSnapshot().entries
    const summary = this.client.sessions.list.getSnapshot().byId[binding.sessionId]
    const usage = windowUsage(entries)
    const model = modelSchema.safeParse(binding.session.projections.faceOf('modelSelection').getSnapshot())
    const route = model.success && model.data.next !== null ? `${model.data.next.provider}/${model.data.next.model}` : this.defaultModel
    const inbox = inboxSchema.safeParse(binding.session.projections.faceOf('inbox').getSnapshot())
    const pending = inbox.success ? [...inbox.data['next-turn'].map(message => ({ message, mode: t.queue })),
      ...inbox.data['next-step'].map(message => ({ message, mode: t.steer }))] : []
    const connection = this.connection.state.getSnapshot()
    this.renderer.update({
      title: `${t.title} · ${summary?.displayTitle ?? binding.sessionId}`,
      rows: [...transcriptRows(entries, snapshot), ...pending.map(({ message, mode }) => ({
        key: `queue:${message.id}`, kind: 'user' as const, title: mode,
        text: message.content.map(block => block.text ?? `[${block.type}]`).join('\n'),
      }))],
      footer: [connection === 'connected' ? t.connected : connection === 'disconnected' ? t.disconnected : t.connecting,
        snapshot.running ? t.running : t.idle, `${this.mode === 'queue' ? t.queue : t.steer} (${pending.length})`, route,
        summary?.cwd ?? this.options.cwd, `${t.windowTokens} ↑${usage.inputTokens} ↓${usage.outputTokens}`].filter(Boolean).join(' · '),
    })
    if (snapshot.removed) this.renderer.notice(t.sessionRemoved)
    else if (snapshot.openError) this.renderer.notice(`${snapshot.openError.code}: ${snapshot.openError.message}`)
    else if (snapshot.promptError) this.renderer.notice(`${snapshot.promptError.error.code}: ${snapshot.promptError.error.message}`)
    else if (snapshot.lastAgentError) this.renderer.notice(snapshot.lastAgentError)
  }

  private async picker(query?: string): Promise<void> {
    await this.client.sessions.refresh()
    const list = this.client.sessions.list.getSnapshot()
    const rows = list.ids.flatMap((id) => {
      const row = list.byId[id]
      return row === undefined ? [] : [row]
    })
    const direct = query === undefined ? undefined : rows.find(row => row.id === query)
    if (direct !== undefined) { await this.select(direct.id); return }
    const selection = await this.host.view.choose(t.sessions, rows.filter(row => !query || `${row.displayTitle} ${row.id}`.toLowerCase().includes(query.toLowerCase()))
      .map(row => ({ label: row.displayTitle, description: `${row.id} · ${row.cwd ?? ''}`, value: row.id })))
    if (selection !== undefined) await this.select(selection)
  }

  private async prompt(text: string, mode = this.mode): Promise<void> {
    const session = this.required()
    const submission = session.beginSubmission({ mode, text, attachments: [] })
    try {
      accepted(await session.prompt([{ type: 'text', text }], mode, this.options.signal, submission.requestId))
    } catch (error) { submission.abandon(); throw error }
    this.renderer.accepted(text)
  }

  private async submit(text: string): Promise<void> {
    if (!text.startsWith('/')) { await this.prompt(text); return }
    const [command = '', ...rest] = text.slice(1).split(/\s+/)
    const argument = rest.join(' ').trim()
    const view = this.host.view
    switch (command) {
      case 'quit': case 'exit': this.quit(); return
      case 'new': await this.create(argument || undefined); break
      case 'sessions': case 'load': case 'resume': await this.picker(argument || undefined); break
      case 'rename': {
        const title = argument || await view.input(t.rename)
        if (title !== undefined) accepted(await this.required().rename(title))
        break
      }
      case 'fork': await this.select(await this.client.sessions.fork({ sessionId: this.required().sessionId, increaseTitle: true })); break
      case 'model': await this.models(); break
      case 'cancel': accepted(await this.required().cancel()); break
      case 'older': await this.required().loadOlder(); break
      case 'queue':
        if (argument) await this.prompt(argument, 'queue')
        else await this.queue()
        break
      case 'steer':
        if (argument) await this.prompt(argument, 'steer')
        else this.mode = 'steer'
        break
      case 'tools': this.renderer.toolsExpanded = !this.renderer.toolsExpanded; break
      case 'reasoning': this.renderer.reasoningExpanded = !this.renderer.reasoningExpanded; break
      case 'questions': await this.interactions.answerContinued(this.required()); break
      case 'help':
        await this.catalog.refresh(this.required().sessionId, this.options.signal)
        await view.show(t.title, this.catalog.list().map(item => `/${item.name} ${item.description ?? ''}`).join('\n\n'))
        break
      default: {
        if (await handleTerminalFeature(text, this.host)) break
        const result = accepted(await this.required().command(text))
        if (!result.matched) {
          await this.catalog.refresh(this.required().sessionId, this.options.signal)
          if (this.catalog.list().some(item => item.name === command && item.kind === 'skill')) await this.prompt(text)
          else throw new Error(`${t.unknownCommand} /${command}`)
        }
      }
    }
    this.renderer.accepted(text)
    this.update()
  }

  private async models(): Promise<void> {
    const catalog = accepted(await this.client.remote.session.modelCatalog())
    const selection = await this.host.view.choose(t.model, catalog.groups.flatMap(group => group.models.map(model => ({
      label: `${group.name} / ${model.name}`, ...(model.description === undefined ? {} : { description: model.description }),
      value: { provider: group.id, model: model.id, reasoning: model.reasoning },
    }))))
    if (selection === undefined) return
    let reasoningEffort: string | undefined
    if (selection.reasoning !== undefined) {
      const effort = await this.host.view.choose<{ id: string | undefined }>(t.effort, [
        { label: t.providerDefault, value: { id: undefined } },
        ...selection.reasoning.efforts.map(effort => ({ label: effort.name,
          ...(effort.description === undefined ? {} : { description: effort.description }), value: { id: effort.id } })),
      ])
      if (effort === undefined) return
      reasoningEffort = effort.id
    }
    accepted(await this.client.remote.session.selectModel({ sessionId: this.required().sessionId,
      provider: selection.provider, model: selection.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }) }))
  }

  private async queue(): Promise<void> {
    this.mode = 'queue'
    const session = this.required()
    const value = session.projections.faceOf('inbox').getSnapshot()
    if (value === undefined) throw new Error(t.queueUnavailable)
    const inbox = inboxSchema.parse(value)
    const messages = [...inbox['next-turn'], ...inbox['next-step']]
    if (messages.length === 0) return
    const selected = await this.host.view.choose(t.queued, messages.map(message => ({
      label: message.content.map(block => block.text ?? `[${block.type}]`).join('\n'), value: message,
    })))
    if (selected === undefined) return
    const action = await this.host.view.choose(t.message, [
      { label: t.edit, value: 'edit' as const }, { label: t.remove, value: 'remove' as const }, { label: t.moveToSteer, value: 'steer' as const },
    ])
    if (action === undefined) return
    const id = brandString<MessageId>(selected.id)
    if (action === 'edit') {
      const text = await this.host.view.input(t.message, { initial: selected.content.map(block => block.text ?? '').join('\n') })
      if (text !== undefined) accepted(await session.updateQueue(id, { kind: 'edit', content: [{ type: 'text', text }] }))
    } else accepted(await session.updateQueue(id, { kind: action }))
  }

  dispose(): void {
    this.selection += 1
    this.interactions.dispose()
    for (const unsubscribe of [...this.unsubscribe, ...this.sessionSubscriptions]) unsubscribe()
    this.reference?.release()
    this.reference = undefined
    this.renderer.stop()
  }
}

/**
 * Own one interactive terminal lifetime. The caller owns Client transport and Host shutdown.
 * @param client - fully mounted Client Context with answerable Remote interactions.
 * @param options - resolved initial navigation and cancellation.
 * @returns after exit or cancellation, with raw mode and retained Session ownership released.
 */
export async function runTerminalApp(client: Context, options: TerminalAppOptions): Promise<void> {
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  const ended = Promise.withResolvers<void>()
  const stop = (): void => { controller.abort(); ended.resolve() }
  signal.addEventListener('abort', stop, { once: true })
  const app = new Conversation(client, { ...options, signal }, stop)
  try {
    signal.throwIfAborted()
    await app.open()
    await ended.promise
  } finally {
    signal.removeEventListener('abort', stop)
    controller.abort()
    app.dispose()
  }
}
