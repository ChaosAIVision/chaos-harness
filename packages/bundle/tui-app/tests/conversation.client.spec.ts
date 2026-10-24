/** Terminal editor and request presentation behavior through real Pi components. */
import { describe, expect, it } from 'vitest'
import type { Terminal } from '@earendil-works/pi-tui'
import { TerminalRenderer } from '../src/renderer.ts'
import { collectQuestionAnswers, TerminalQuestionError } from '../src/interactions.ts'
import type { TerminalChoice, TerminalPresentation } from '../src/types.ts'

class TestTerminal implements Terminal {
  columns = 80
  rows = 24
  kittyProtocolActive = false
  stopped = false
  output = ''
  input: (data: string) => void = () => undefined
  resize: () => void = () => undefined
  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; this.stopped = false }
  stop(): void { this.stopped = true }
  async drainInput(): Promise<void> {}
  write(text: string): void { this.output += text }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function renderer(terminal = new TestTerminal()): { view: TerminalRenderer; terminal: TestTerminal; submissions: string[] } {
  const submissions: string[] = []
  const view = new TerminalRenderer({ submit: (text) => { submissions.push(text) }, cancel: () => undefined,
    older: () => undefined, quit: () => undefined }, terminal)
  view.start()
  return { view, terminal, submissions }
}

describe('terminal conversation views', () => {
  it('submits bracketed multiline paste once and retains the draft until acceptance', () => {
    const { view, terminal, submissions } = renderer()
    try {
      terminal.input('\u001b[200~first\nsecond\u001b[201~')
      expect(submissions).toEqual([])
      terminal.input('\r')
      expect(submissions).toEqual(['first\nsecond'])
      expect(view.editor.getExpandedText()).toBe('first\nsecond')
      view.accepted('first\nsecond')
      view.submissionFinished()
      expect(view.editor.getExpandedText()).toBe('')
    } finally { view.stop() }
    expect(terminal.stopped).toBe(true)
  })

  it('returns typed choices even when labels are identical', async () => {
    const { view, terminal } = renderer()
    try {
      const first = { id: 1 }
      const second = { id: 2 }
      const choice = view.scoped(new AbortController().signal).choose('Select', [
        { label: 'Same', value: first }, { label: 'Same', value: second },
      ])
      await tick()
      terminal.input('\u001b[B')
      terminal.input('\r')
      expect(await choice).toBe(second)
    } finally { view.stop() }
  })

  it('withdraws cancelled overlays and never transfers a stale Enter to another request', async () => {
    const { view, terminal } = renderer()
    try {
      const controller = new AbortController()
      const cancelled = view.scoped(controller.signal).choose('First', [{ label: 'A', value: 'first' }])
      const next = view.scoped(new AbortController().signal).choose('Second', [{ label: 'B', value: 'second' }])
      await tick()
      controller.abort()
      expect(await cancelled).toBeUndefined()
      await tick()
      terminal.input('\r')
      expect(await next).toBe('second')
    } finally { view.stop() }
  })

  it('settles a queued request promptly when it is cancelled behind another active presentation', async () => {
    const { view, terminal } = renderer()
    try {
      const active = view.scoped(new AbortController().signal).choose('First', [{ label: 'A', value: 'first' }])
      const controller = new AbortController()
      const queued = view.scoped(controller.signal).input('Cancelled while queued')
      await tick()
      controller.abort()
      expect(await queued).toBeUndefined()
      terminal.input('\r')
      expect(await active).toBe('first')
    } finally { view.stop() }
  })

  it('masks secrets in all rendered terminal output', async () => {
    const { view, terminal } = renderer()
    try {
      const input = view.scoped(new AbortController().signal).input('Secret', { secret: true })
      await tick()
      terminal.input('top-secret')
      view.tui.requestRender(true)
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(terminal.output).not.toContain('top-secret')
      expect(terminal.output).toContain('••••')
      terminal.input('\r')
      expect(await input).toBe('top-secret')
    } finally { view.stop() }
  })

  it('strips untrusted terminal escapes from every text presentation and editable draft', async () => {
    const { view, terminal } = renderer()
    const hostile = '\u001b]52;c;c2VjcmV0\u0007\u001b[31mremote text\u001b[0m'
    try {
      view.update({ title: hostile, footer: hostile, rows: [{ key: 'row', kind: 'assistant', title: hostile, text: hostile }] })
      view.notice(hostile)
      view.editor.setText(hostile)
      expect(view.render(80).join('\n')).not.toContain('\u001b]52')
      expect(view.render(80).join('\n')).not.toContain('\u001b[31m')
      const choice = view.scoped(new AbortController().signal).choose(hostile, [{ label: hostile, description: hostile, value: 1 }])
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(terminal.output).not.toContain('\u001b]52')
      expect(terminal.output).not.toContain('\u001b[31m')
      terminal.input('\r')
      expect(await choice).toBe(1)
      const input = view.scoped(new AbortController().signal).input(hostile, { initial: hostile })
      await tick()
      terminal.input('\r')
      expect(await input).toBe('remote text')
      const document = view.scoped(new AbortController().signal).show(hostile, hostile)
      await tick()
      terminal.input('\u001b')
      await document
      expect(terminal.output).not.toContain('\u001b]52')
    } finally { view.stop() }
  })

  it('gives PTY input exclusive ownership and restores the editor after an error', async () => {
    const { view, terminal, submissions } = renderer()
    try {
      const observed: string[] = []
      const session = view.scoped(new AbortController().signal).terminal('PTY', async (lease) => {
        lease.onInput((text) => { observed.push(text) })
        terminal.input('shell command\r')
        expect(lease.size()).toEqual({ columns: 80, rows: 24 })
        throw new Error('PTY disconnected')
      })
      await expect(session).rejects.toThrow('PTY disconnected')
      expect(observed).toEqual(['shell command\r'])
      expect(submissions).toEqual([])
      terminal.input('editor')
      expect(view.editor.getExpandedText()).toBe('editor')
    } finally { view.stop() }
  })
})

class AnswerView implements TerminalPresentation {
  readonly titles: string[] = []
  readonly details: string[] = []
  constructor(private readonly indices: number[], private readonly custom = '') {}
  async choose<T>(title: string, choices: readonly TerminalChoice<T>[]): Promise<T | undefined> {
    this.titles.push(title)
    const index = this.indices.shift()
    return index === undefined ? undefined : choices[index]?.value
  }
  async input(): Promise<string> { return this.custom }
  async show(_title: string, text: string): Promise<void> { this.details.push(text) }
  async terminal(): Promise<void> {}
}

describe('terminal question answers', () => {
  it('preserves pstack setup approval and decline labels verbatim', async () => {
    const question = { id: 'pstack', question: 'Set up pstack?', detail: 'Exact plan', options: [
      { label: 'Set up models' }, { label: 'Keep current setup' },
    ], intent: { kind: 'plan-review' as const, approve: 'Set up models' } }
    for (const [index, label] of [[0, 'Set up models'], [1, 'Keep current setup']] as const) {
      const view = new AnswerView([index])
      expect(await collectQuestionAnswers([question], view, new AbortController().signal))
        .toEqual({ answers: [{ id: 'pstack', selected: [label] }] })
      expect(view.details).toEqual(['Exact plan'])
    }
  })

  it('keeps each question id and the exact selected labels in a multiselect batch', async () => {
    const view = new AnswerView([0, 1, 3, 0])
    const result = await collectQuestionAnswers([
      { id: 'models', question: 'Models', multiSelect: true, options: [{ label: 'Sol' }, { label: 'Astra' }] },
      { id: 'next', question: 'Continue?', options: [{ label: 'Continue' }] },
    ], view, new AbortController().signal)
    expect(result).toEqual({ answers: [{ id: 'models', selected: ['Sol', 'Astra'] }, { id: 'next', selected: ['Continue'] }] })
  })

  it('cancels instead of manufacturing a negative or positive answer', async () => {
    await expect(collectQuestionAnswers([{ id: 'request', question: 'Proceed?', options: [{ label: 'Yes' }] }],
      new AnswerView([]), new AbortController().signal)).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    const controller = new AbortController()
    controller.abort()
    await expect(collectQuestionAnswers([{ id: 'request', question: 'Proceed?' }], new AnswerView([]), controller.signal))
      .rejects.toBeInstanceOf(TerminalQuestionError)
  })
})
