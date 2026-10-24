/** Pi terminal primitives, focus ownership, and cancellable terminal presentations. */
import {
  Container, CURSOR_MARKER, Editor, Input, Markdown, matchesKey, ProcessTerminal,
  SelectList, Text, TUI, truncateToWidth,
  type AutocompleteProvider, type Component, type Focusable, type MarkdownTheme, type SelectListTheme, type Terminal,
} from '@earendil-works/pi-tui'
import { conversationText as t } from './conversation-locales.ts'
import { terminalText, type TranscriptRow } from './transcript.ts'
import type { TerminalChoice, TerminalPresentation } from './types.ts'

const plain = (text: string): string => text
const dim = (text: string): string => `\u001b[2m${text}\u001b[22m`
const accent = (text: string): string => `\u001b[36m${text}\u001b[39m`
const bold = (text: string): string => `\u001b[1m${text}\u001b[22m`
const selectionTheme: SelectListTheme = {
  selectedPrefix: accent, selectedText: bold, description: dim, scrollInfo: dim, noMatch: dim,
}
const markdownTheme: MarkdownTheme = {
  heading: bold, link: accent, linkUrl: dim, code: accent, codeBlock: plain, codeBlockBorder: dim,
  quote: dim, quoteBorder: dim, hr: dim, listBullet: accent, bold, italic: plain, strikethrough: plain, underline: plain,
}

function editableLines(component: Component, width: number): string[] {
  return component.render(width).map(line => line.split(CURSOR_MARKER).map(terminalText).join(CURSOR_MARKER))
}

function safeInput(component: Component): Component {
  return { render: width => editableLines(component, width), invalidate: () => component.invalidate() }
}

type Focus =
  | { readonly kind: 'editor' }
  | { readonly kind: 'transcript' }
  | { readonly kind: 'panel'; readonly component: Component; readonly cancel: () => void }
  | { readonly kind: 'terminal' }

class Panel extends Container implements Focusable {
  focused = true
  constructor(private readonly input: (data: string) => void) { super() }
  handleInput(data: string): void { this.input(data) }
}

/** Keyboard actions the renderer delegates to the conversation owner. */
export interface TerminalActions {
  submit(text: string): void
  cancel(): void
  quit(): void
  older(): void
}

/** Terminal focus and rendering, with no durable Session or Agent ownership. */
export class TerminalRenderer implements Component {
  /** Pi owns differential output and terminal protocol negotiation. */
  readonly tui: TUI
  /** Pi owns multiline editing, bracketed paste, undo, and completion. */
  readonly editor: Editor
  private focus: Focus = { kind: 'editor' }
  private rows: readonly TranscriptRow[] = []
  private title: string = t.title
  private footer = ''
  private status = ''
  private scroll = 0
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private started = false
  private readonly closedSignal = new AbortController()
  /** Whether all tool bodies are expanded in the transcript. */
  toolsExpanded = false
  /** Whether reasoning bodies are expanded in the transcript. */
  reasoningExpanded = false

  constructor(private readonly actions: TerminalActions, readonly terminal: Terminal = new ProcessTerminal()) {
    this.tui = new TUI(terminal, true)
    this.editor = new Editor(this.tui, { borderColor: dim, selectList: selectionTheme }, { paddingX: 1 })
    this.editor.onSubmit = (text) => {
      if (!text.trim()) return
      this.editor.setText(text)
      this.editor.disableSubmit = true
      actions.submit(text)
    }
    this.tui.addChild(this)
    this.tui.setFocus(this.editor)
    this.tui.addInputListener((data) => {
      if (this.focus.kind === 'terminal') return { consume: true }
      if (matchesKey(data, 'ctrl+c')) { actions.quit(); return { consume: true } }
      if (this.focus.kind === 'panel') return undefined
      if (matchesKey(data, 'escape') && !this.editor.isShowingAutocomplete()) {
        if (this.focus.kind === 'transcript') { this.focus = { kind: 'editor' }; this.tui.setFocus(this.editor) }
        else actions.cancel()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+o')) {
        this.focus = this.focus.kind === 'editor' ? { kind: 'transcript' } : { kind: 'editor' }
        this.tui.setFocus(this.focus.kind === 'editor' ? this.editor : this)
        this.tui.requestRender()
        return { consume: true }
      }
      if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
        this.scroll = Math.max(0, this.scroll + (matchesKey(data, 'pageUp') ? 1 : -1) * Math.max(1, terminal.rows - 8))
        this.tui.requestRender()
        return { consume: true }
      }
      return undefined
    })
  }

  /** Enter raw terminal mode after interaction consumers have been registered. */
  start(): void { this.started = true; this.tui.start() }

  /** Restore the terminal and settle all pending presentations. */
  stop(): void {
    this.closed = true
    this.closedSignal.abort()
    if (this.focus.kind === 'panel') this.focus.cancel()
    if (this.started) this.tui.stop()
    this.started = false
  }

  /**
   * Install editor discovery.
   * @param provider - the live Host/skill/local slash catalog.
   */
  setAutocomplete(provider: AutocompleteProvider): void { this.editor.setAutocompleteProvider(provider) }

  /**
   * Publish a terminal frame.
   * @param state - current presentation from the retained Client Session.
   */
  update(state: { title: string; rows: readonly TranscriptRow[]; footer: string }): void {
    this.title = terminalText(state.title)
    this.rows = state.rows
    this.footer = terminalText(state.footer)
    this.tui.requestRender()
  }

  /**
   * Retire an accepted draft.
   * @param text - accepted prompt to record in editor history.
   */
  accepted(text: string): void {
    this.editor.addToHistory(text)
    if (this.editor.getExpandedText() === text) this.editor.setText('')
    this.scroll = 0
    this.tui.requestRender()
  }

  /** Re-enable submission after admission or a visible failure, retaining an unaccepted draft. */
  submissionFinished(): void { this.editor.disableSubmit = false; this.tui.requestRender() }

  /**
   * Report an operation outcome.
   * @param text - user-visible operation result or failure.
   */
  notice(text: string): void { this.status = terminalText(text); this.tui.requestRender() }

  /** Invalidate width-dependent primitive caches. */
  invalidate(): void { this.editor.invalidate() }

  /** @param data - keys delivered only while transcript navigation owns focus. */
  handleInput(data: string): void {
    if (matchesKey(data, 'up')) this.scroll += 1
    if (matchesKey(data, 'down')) this.scroll = Math.max(0, this.scroll - 1)
    if (matchesKey(data, 'home')) this.scroll = Number.MAX_SAFE_INTEGER
    if (matchesKey(data, 'end')) this.scroll = 0
    if (matchesKey(data, 'enter')) this.actions.older()
    this.tui.requestRender()
  }

  /** @param width - available terminal columns. @returns the current visible terminal frame. */
  render(width: number): string[] {
    const content = this.rows.flatMap((row) => {
      const folded = row.kind === 'tool' && !this.toolsExpanded || row.kind === 'reasoning' && !this.reasoningExpanded
      const title = terminalText(`${row.title}${folded ? ` · ${t.folded}` : ''}`)
      const text = terminalText(row.text)
      return [row.kind === 'user' ? accent(title) : bold(title),
        ...(folded ? new Text(text.split('\n')[0] ?? '', 1, 0).render(width).slice(0, 2)
          : new Markdown(text, 1, 0, markdownTheme).render(width)), '']
    })
    if (content.length === 0) content.push(t.welcome)
    const editor = editableLines(this.editor, width)
    const height = Math.max(1, this.terminal.rows - editor.length - 5)
    this.scroll = Math.min(this.scroll, Math.max(0, content.length - height))
    const bottom = content.length - this.scroll
    const visible = content.slice(Math.max(0, bottom - height), bottom)
    return [truncateToWidth(bold(this.title), width), '', ...visible,
      truncateToWidth(dim(this.status), width), ...editor,
      truncateToWidth(dim(this.footer), width), truncateToWidth(dim(t.hints), width)]
  }

  /**
   * Bind each presentation to the exact request lifetime that owns its answer.
   * @param signal - request or application lifetime.
   * @returns a typed presentation whose cancelled views cannot return stale selections.
   */
  scoped(signal: AbortSignal): TerminalPresentation {
    const lifetime = AbortSignal.any([signal, this.closedSignal.signal])
    return {
      choose: <T>(title: string, choices: readonly TerminalChoice<T>[]) =>
        this.enqueue(lifetime, () => this.choose(title, choices, lifetime)),
      input: (title, options) => this.enqueue(lifetime, () => this.input(title, options, lifetime)),
      show: async (title, text) => { await this.enqueue(lifetime, () => this.show(title, text, lifetime)) },
      terminal: async (title, run) => { await this.enqueue(lifetime, () => this.terminalView(title, run, lifetime)) },
    }
  }

  private async terminalView(title: string, run: Parameters<TerminalPresentation['terminal']>[1], signal: AbortSignal): Promise<void> {
    const controller = new AbortController()
    const lifetime = AbortSignal.any([signal, controller.signal])
    const inputs = new Set<(data: string) => void>()
    const resizes = new Set<(size: { columns: number; rows: number }) => void>()
    this.focus = { kind: 'terminal' }
    this.tui.stop()
    this.started = false
    try {
      this.terminal.start((data) => {
        if (matchesKey(data, 'ctrl+]')) controller.abort()
        else for (const input of inputs) input(data)
      }, () => {
        for (const resize of resizes) resize({ columns: this.terminal.columns, rows: this.terminal.rows })
      })
      this.terminal.write(`\u001b[2J\u001b[H${terminalText(title)} · ${t.terminalHints}\r\n`)
      await run({
        signal: lifetime,
        size: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
        write: (text) => { if (!lifetime.aborted) this.terminal.write(text) },
        onInput: (listener) => { inputs.add(listener); return () => { inputs.delete(listener) } },
        onResize: (listener) => { resizes.add(listener); return () => { resizes.delete(listener) } },
      })
    } finally {
      controller.abort()
      inputs.clear()
      resizes.clear()
      this.terminal.stop()
      this.focus = { kind: 'editor' }
      this.tui.setFocus(this.editor)
      if (!this.closed) this.start()
    }
  }

  private enqueue<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T | undefined> {
    const run = this.queue.then(() => this.closed || signal.aborted ? undefined : operation())
    this.queue = run.then(() => undefined, () => undefined)
    if (signal.aborted) return Promise.resolve(undefined)
    const aborted = Promise.withResolvers<undefined>()
    const cancel = (): void => { aborted.resolve(undefined) }
    signal.addEventListener('abort', cancel, { once: true })
    return Promise.race([run, aborted.promise]).finally(() => { signal.removeEventListener('abort', cancel) })
  }

  private panel<T>(component: Component, signal: AbortSignal, completion: PromiseWithResolvers<T | undefined>): Promise<T | undefined> {
    if (signal.aborted) return Promise.resolve(undefined)
    const cancel = (): void => { completion.resolve(undefined) }
    const handle = this.tui.showOverlay(component, { width: '90%', maxHeight: '85%', anchor: 'center' })
    this.focus = { kind: 'panel', component, cancel }
    signal.addEventListener('abort', cancel, { once: true })
    return completion.promise.finally(() => {
      signal.removeEventListener('abort', cancel)
      handle.hide()
      this.focus = { kind: 'editor' }
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    })
  }

  private choose<T>(title: string, choices: readonly TerminalChoice<T>[], signal: AbortSignal): Promise<T | undefined> {
    const completion = Promise.withResolvers<T | undefined>()
    const list = new SelectList(choices.map((choice, index) => ({ value: String(index), label: terminalText(choice.label),
      ...(choice.description === undefined ? {} : { description: terminalText(choice.description) }) })),
    Math.max(1, this.terminal.rows - 10), selectionTheme)
    const filter = new Input()
    list.onSelect = (item) => { completion.resolve(choices[Number(item.value)]?.value) }
    list.onCancel = () => { completion.resolve(undefined) }
    const panel = new Panel((data) => {
      if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'up') || matchesKey(data, 'down')) list.handleInput(data)
      else { filter.handleInput(data); list.setFilter(filter.getValue()) }
      this.tui.requestRender()
    })
    panel.addChild(new Text(bold(terminalText(title))))
    panel.addChild(safeInput(filter))
    panel.addChild(list)
    if (choices.length === 0) panel.addChild(new Text(t.empty))
    panel.addChild(new Text(dim(t.overlayHints)))
    return this.panel(panel, signal, completion)
  }

  private input(title: string, options: { readonly initial?: string; readonly secret?: boolean } | undefined,
    signal: AbortSignal): Promise<string | undefined> {
    const completion = Promise.withResolvers<string | undefined>()
    const input = new Input()
    input.focused = true
    input.setValue(terminalText(options?.initial ?? ''))
    input.onSubmit = (value) => { completion.resolve(value) }
    input.onEscape = () => { completion.resolve(undefined) }
    const panel = new Panel((data) => { input.handleInput(data); this.tui.requestRender() })
    panel.addChild(new Text(bold(terminalText(title))))
    panel.addChild(options?.secret === true ? {
      render: width => [`${'•'.repeat(Math.min(width - 1, [...input.getValue()].length))}${CURSOR_MARKER}`],
      invalidate: () => undefined,
    } : safeInput(input))
    panel.addChild(new Text(dim(t.inputHints)))
    return this.panel(panel, signal, completion)
  }

  private show(title: string, text: string, signal: AbortSignal): Promise<void | undefined> {
    const completion = Promise.withResolvers<void | undefined>()
    const markdown = new Markdown(terminalText(text), 1, 0, markdownTheme)
    let offset = 0
    const height = Math.max(1, this.terminal.rows - 8)
    const panel = new Panel((data) => {
      if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) completion.resolve()
      if (matchesKey(data, 'up')) offset = Math.max(0, offset - 1)
      if (matchesKey(data, 'down')) offset += 1
      if (matchesKey(data, 'pageUp')) offset = Math.max(0, offset - height)
      if (matchesKey(data, 'pageDown')) offset += height
      this.tui.requestRender()
    })
    panel.addChild(new Text(bold(terminalText(title))))
    panel.addChild({
      render: (width) => {
        const lines = markdown.render(width)
        offset = Math.min(offset, Math.max(0, lines.length - height))
        return lines.slice(offset, offset + height)
      }, invalidate: () => markdown.invalidate(),
    })
    panel.addChild(new Text(dim(t.documentHints)))
    return this.panel(panel, signal, completion)
  }
}
