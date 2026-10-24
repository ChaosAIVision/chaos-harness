/** User-visible feature behavior against typed Remote operation scripts and real document decoders. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleTerminalFeature, terminalFeatureCommands } from '../src/features.ts'
import { diff, document, exportSession, htmlText, saveBytes } from '../src/resources.ts'
import type { TerminalChoice, TerminalFeatureHost, TerminalPresentation } from '../src/types.ts'
import { featureText as t } from '../src/features/locales.ts'

const ready = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
const id = SessionId('terminal-feature-session')
const unused = (): never => { throw new Error('Unexpected session operation') }
const session: SessionFace = {
  sessionId: id,
  projections: { faceOf: unused },
  beginSubmission: unused, prompt: unused, readAttachment: unused, updateQueue: unused,
  cancel: unused, rename: unused, loadOlder: unused, loadThrough: unused, command: unused,
  getSnapshot: unused, subscribe: unused,
}

function harness(remote: object, labels: string[] = [], values: string[] = []) {
  const shown: { title: string; text: string }[] = []
  const inputs: { title: string; secret: boolean }[] = []
  const view: TerminalPresentation = {
    async choose<T>(_title: string, choices: readonly TerminalChoice<T>[]): Promise<T | undefined> {
      const label = labels.shift()
      if (label === undefined) return undefined
      const row = choices.find(choice => choice.label === label)
      if (row === undefined) throw new Error(`Missing choice ${label}`)
      return row.value
    },
    async input(title, options) { inputs.push({ title, secret: options?.secret ?? false }); return values.shift() },
    async show(title, text) { shown.push({ title, text }) },
    async terminal() { throw new Error('Unexpected keyboard lease') },
  }
  const client = Object.assign(new Context(), { remote })
  const host: TerminalFeatureHost = {
    client, signal: new AbortController().signal, current: () => session, select: vi.fn(), view,
    request: async () => { throw new Error('Unexpected HTTP request') },
  }
  return { host, shown, inputs }
}

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-tui-features-'))
  directories.push(path)
  return path
}

describe('Terminal feature operations', () => {
  it('leaves Host commands and text to the existing command path', async () => {
    const h = harness({})
    expect(await handleTerminalFeature('/goal Build the demo', h.host)).toBe(false)
    expect(await handleTerminalFeature('hello', h.host)).toBe(false)
    expect(await handleTerminalFeature('/plan', h.host)).toBe(false)
    expect(new Set(terminalFeatureCommands.map(command => command.name)).size).toBe(terminalFeatureCommands.length)
  })

  it('selects the exact provider/model and adapter-owned reasoning value', async () => {
    const selectModel = vi.fn(async () => ready({ selected: { provider: 'route-b', model: 'model-id', reasoningEffort: 'high-id' } }))
    const h = harness({ session: {
      modelCatalog: async () => ready({ default: { provider: 'route-b', model: 'model-id' }, routableProviders: ['route-b'], failures: [], groups: [
        { id: 'route-b', name: 'Provider B', models: [{ id: 'model-id', name: 'Model display', reasoning: { efforts: [{ id: 'high-id', name: 'Thorough' }] } }] },
      ] }), selectModel,
    } }, ['Provider B / Model display', 'Thorough'])
    expect(await handleTerminalFeature('/model', h.host)).toBe(true)
    expect(selectModel).toHaveBeenCalledWith({ sessionId: id, provider: 'route-b', model: 'model-id', reasoningEffort: 'high-id' })
  })

  it('masks secret settings and preserves the observed namespace revision', async () => {
    const mutate = vi.fn(async () => ready({ ns: 'llm', revision: 13, value: {} }))
    const h = harness({ settings: {
      describe: async () => ready({ writable: true, namespaces: [{ ns: 'llm', revision: 12, secrets: [{ path: ['apiKey'], set: false }], value: {}, schema: {} }] }), mutate,
    } }, ['llm', t.settingsSet], ['["apiKey"]', 'secret-only-in-request'])
    await handleTerminalFeature('/settings', h.host)
    expect(h.inputs.at(-1)).toEqual({ title: t.secret, secret: true })
    expect(mutate).toHaveBeenCalledWith('llm', [{ op: 'set', path: ['apiKey'], value: 'secret-only-in-request' }], 12)
    expect(JSON.stringify(h.shown)).not.toContain('secret-only-in-request')
  })

  it('reports a stale settings refusal without a successful receipt', async () => {
    const h = harness({ settings: {
      describe: async () => ready({ writable: true, namespaces: [{ ns: 'llm', revision: 4, secrets: [], value: {}, schema: {} }] }),
      mutate: async () => ({ ok: false, error: { code: 'settings/conflict', message: 'Revision moved' } }),
    } }, ['llm', t.settingsSet], ['["baseURL"]', '"https://example.test"'])
    await handleTerminalFeature('/settings', h.host)
    expect(h.shown).toEqual([{ title: t.error, text: 'settings/conflict: Revision moved' }])
  })

  it('passes malformed settings JSON to no Remote mutation', async () => {
    const mutate = vi.fn()
    const h = harness({ settings: {
      describe: async () => ready({ writable: true, namespaces: [{ ns: 'llm', revision: 1, secrets: [], value: {}, schema: {} }] }), mutate,
    } }, ['llm', t.settingsSet], ['not JSON'])
    await handleTerminalFeature('/settings', h.host)
    expect(mutate).not.toHaveBeenCalled()
    expect(h.shown[0]?.title).toBe(t.error)
  })

  it('closes the job roster subscription when the picker is cancelled', async () => {
    const dispose = vi.fn()
    const stream = { async *[Symbol.asyncIterator]() { yield { type: 'rows', jobs: [] } }, dispose }
    const h = harness({ job: { list: () => stream } })
    await handleTerminalFeature('/jobs', h.host)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('uses the exact expected reminder for a timing update', async () => {
    const record = { id: 'schedule-id', sessionId: id, status: 'active', kind: 'at', title: 'Reminder', prompt: 'Review it', scheduledAt: '2026-10-28T00:00:00Z' }
    const update = vi.fn(async () => ready({ updated: true, record }))
    const h = harness({ schedule: { catalog: async () => ready([record]), update } }, ['Reminder [active]', t.changeTime, t.every], ['120'])
    await handleTerminalFeature('/schedules', h.host)
    expect(update).toHaveBeenCalledWith({ sessionId: id, id: 'schedule-id', expected: record, change: { kind: 'every', every_seconds: 120 } })
  })

  it('saves exports through the authenticated route and refuses local overwrite', async () => {
    const path = join(await directory(), 'session.zip')
    const h = harness({}, ['ZIP'], [path])
    const request = vi.fn<TerminalFeatureHost['request']>(async () => new Response(new Uint8Array([80, 75, 3, 4])))
    h.host.request = request
    await exportSession(h.host)
    expect(request.mock.calls[0]?.[0]).toContain('api/session.export?sessionId=terminal-feature-session&includeDescendants=true')
    expect(await readFile(path)).toEqual(Buffer.from([80, 75, 3, 4]))
    await expect(saveBytes(path, new Uint8Array([9]))).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('does not create a local export when the Host refuses access', async () => {
    const path = join(await directory(), 'refused.md')
    const h = harness({}, ['Markdown'], [path])
    h.host.request = async () => new Response('', { status: 403 })
    await expect(exportSession(h.host)).rejects.toThrow('HTTP 403')
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('opens a recorded comparison through its exact session, announcement and file index', async () => {
    const h = harness({}, ['42 {\n  "turn": 2\n}', 'src/app.ts +1 -1'])
    Object.assign(h.host.client, { sessions: { binding: () => ({ eventSource: { getSnapshot: () => ({ entries: [{ event: { seq: 42, type: 'workspace/changes', data: { turn: 2 } } }] }) } }) } })
    const request = vi.fn<TerminalFeatureHost['request']>(async path => new Response(JSON.stringify(path.startsWith('api/changes.summary')
      ? { turn: 2, files: [{ path: 'src/app.ts', display: 'src/app.ts', added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 }
      : { kind: 'text', display: 'src/app.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] })))
    h.host.request = request
    await diff(h.host)
    expect(request.mock.calls.map(call => call[0])).toEqual([
      'api/changes.summary?sessionId=terminal-feature-session&seq=42',
      'api/changes.diff?sessionId=terminal-feature-session&seq=42&index=0',
    ])
    expect(h.shown[0]?.text).toBe('@@ -1,1 +1,1 @@\n-old\n+new')
  })

  it('releases the exclusive PTY view without closing its persistent shell', async () => {
    const h = harness({ terminal: { list: async () => ready([{ id: 'pty-1', title: 'shell', state: 'running', cwd: '/workspace' }]) } }, ['shell [running]', t.terminalAttach])
    const unmount = vi.fn(), acknowledge = vi.fn(), write = vi.fn(), resize = vi.fn(), unsubscribe = vi.fn(), retainTabs = vi.fn()
    const model = {
      mount: vi.fn(() => unmount), acknowledge, write, resize,
      state: {
        getSnapshot: () => ({ phase: 'connected', writable: true, render: { revision: 1, frame: { type: 'snapshot', screen: 'shell output' } } }),
        subscribe: () => unsubscribe,
      },
    }
    Object.assign(h.host.client, { webTerminals: { view: () => model, retainTabs } })
    const screen = vi.fn(), inputDisposed = vi.fn(), resizeDisposed = vi.fn()
    h.host.view.terminal = async (_title, run) => {
      const abort = new AbortController()
      await run({
        signal: abort.signal, size: () => ({ columns: 100, rows: 32 }), write: screen,
        onInput(listener) { listener('ls\r'); return inputDisposed },
        onResize(listener) { listener({ columns: 120, rows: 40 }); abort.abort(); return resizeDisposed },
      })
    }
    await handleTerminalFeature('/terminals', h.host)
    expect(write).toHaveBeenCalledWith('ls\r')
    expect(resize).toHaveBeenCalledWith(120, 40)
    expect(acknowledge).toHaveBeenCalledWith(1)
    expect(screen).toHaveBeenCalledWith('\x1b[2J\x1b[Hshell output')
    expect(unmount).toHaveBeenCalledOnce()
    expect(inputDisposed).toHaveBeenCalledOnce()
    expect(resizeDisposed).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(retainTabs).toHaveBeenCalledWith([])
  })

  it('renders HTML links and table cells without script or style content', async () => {
    const text = await htmlText('<h1>Result</h1><script>steal()</script><style>body{}</style><table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>7</td></tr></table><a href="/report">Read report</a>')
    expect(text).toContain('Result')
    expect(text).toContain('Name\tValue')
    expect(text).toContain('A\t7')
    expect(text).toContain('Read report (/report)')
    expect(text).not.toContain('steal')
    expect(text).not.toContain('body{}')
  })

  it('decodes real workbook cells into terminal table text', async () => {
    const XLSX = await import('xlsx')
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name', 'Count'], ['Alpha', 3]]), 'Report')
    const bytes: Uint8Array = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
    const h = harness({ workspaceFiles: { readBytes: async () => ready({ data: bytes }) } }, [`${t.sheet}: Report`])
    await document(h.host, 'report.xlsx')
    expect(h.shown).toEqual([{ title: 'report.xlsx · Report', text: 'Name\tCount\nAlpha\t3' }])
  })

  it('extracts real PDF page text inside the terminal', async () => {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Length 50 >>\nstream\nBT /F1 12 Tf 20 40 Td (Terminal PDF text) Tj ET\nendstream',
    ]
    let source = '%PDF-1.4\n'
    const offsets = objects.map((object, index) => { const offset = source.length; source += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset })
    const start = source.length
    source += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF`
    const h = harness({ workspaceFiles: { readBytes: async () => ready({ data: new TextEncoder().encode(source) }) } }, [`${t.pdfPage} 1`])
    await document(h.host, 'report.pdf')
    expect(h.shown[0]?.text).toContain('Terminal PDF text')
  })
})
