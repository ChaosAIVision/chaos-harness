/** Terminal-native file, document, recorded-diff and export presenters. */
import { open, readFile, unlink } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import type { TerminalChoice, TerminalFeatureHost } from './types.ts'
import { accepted, details, selected } from './features/common.ts'
import { featureText as t } from './features/locales.ts'

/** Convert HTML into readable text while retaining table cells and link destinations.
 * @param html - Original document.
 * @returns Text and table-oriented content without active scripts.
 */
export async function htmlText(html: string): Promise<string> {
  const { parse } = await import('parse5')
  const root = parse(html)
  type Node = import('parse5').DefaultTreeAdapterMap['node']
  const blocks = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'li', 'ul', 'ol', 'table', 'tr', 'pre', 'br'])
  const visit = (node: Node): string => {
    if (node.nodeName === '#text' && 'value' in node) return node.value
    if ('tagName' in node && ['script', 'style', 'template', 'noscript'].includes(node.tagName)) return ''
    const content = 'childNodes' in node ? node.childNodes.map(visit).join('') : ''
    if (!('tagName' in node)) return content
    if (node.tagName === 'a') {
      const href = node.attrs.find(attribute => attribute.name === 'href')?.value
      return href === undefined ? content : `${content} (${href})`
    }
    if (node.tagName === 'td' || node.tagName === 'th') return `${content.trim()}\t`
    return blocks.has(node.tagName) ? `\n${content}\n` : content
  }
  return visit(root).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Save exact bytes without overwriting an existing local artifact.
 * @param path - User-selected local path.
 * @param bytes - Original content.
 */
export async function saveBytes(path: string, bytes: Uint8Array): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try {
    try { await file.writeFile(bytes) } finally { await file.close() }
  } catch (error) {
    await unlink(path)
    throw error
  }
}

async function saveFile(host: TerminalFeatureHost, path: string): Promise<void> {
  const destination = await host.view.input(t.localPath, { initial: basename(path) })
  if (destination === undefined) return
  const source = accepted(await host.client.remote.workspaceFiles.readBytes(selected(host).sessionId, path, {}, host.signal))
  await saveBytes(destination, source.data)
  await host.view.show(t.saved, destination)
}

async function pdf(host: TerminalFeatureHost, name: string, bytes: Uint8Array, fonts: readonly string[] = []): Promise<void> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
  const abort = (): void => { void task.destroy() }
  host.signal.addEventListener('abort', abort, { once: true })
  try {
    const document = await task.promise
    while (!host.signal.aborted) {
      const pageNumber = await host.view.choose(name, Array.from({ length: document.numPages }, (_, index) => ({ label: `${t.pdfPage} ${index + 1}`, value: index + 1 })))
      if (pageNumber === undefined) return
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('')
      await host.view.show(`${name} · ${pageNumber}/${document.numPages}`, `${fonts.length === 0 ? '' : `${t.missingFonts}: ${fonts.join(', ')}\n\n`}${text.trim() === '' ? t.pdfNoText : text}`)
      page.cleanup()
    }
  } finally {
    host.signal.removeEventListener('abort', abort)
    await task.destroy()
  }
}

async function spreadsheet(host: TerminalFeatureHost, path: string, bytes: Uint8Array): Promise<void> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(bytes, { type: 'array' })
  while (!host.signal.aborted) {
    const sheet = await host.view.choose(path, workbook.SheetNames.map(name => ({ label: `${t.sheet}: ${name}`, value: name })))
    if (sheet === undefined) return
    const content = workbook.Sheets[sheet]
    if (content === undefined) return
    await host.view.show(`${path} · ${sheet}`, XLSX.utils.sheet_to_csv(content, { FS: '\t' }))
  }
}

/** Open text, tables, HTML, PDF or Office text inside the terminal.
 * @param host - Current terminal services.
 * @param path - Host workspace path.
 */
export async function document(host: TerminalFeatureHost, path: string): Promise<void> {
  const sessionId = selected(host).sessionId
  const extension = extname(path).slice(1).toLowerCase()
  if (['doc', 'docx', 'ppt', 'pptx'].includes(extension)) {
    const result = accepted(await host.client.remote.officeToPdf.render(sessionId, path, 'foreground', host.signal))
    await pdf(host, path, result.data, result.missingFonts)
    return
  }
  if (['pdf', 'xlsx', 'xls', 'csv', 'tsv', 'html', 'htm'].includes(extension)) {
    const result = accepted(await host.client.remote.workspaceFiles.readBytes(sessionId, path, {}, host.signal))
    if (extension === 'pdf') await pdf(host, path, result.data)
    else if (extension === 'html' || extension === 'htm') await host.view.show(path, await htmlText(new TextDecoder().decode(result.data)))
    else await spreadsheet(host, path, result.data)
    return
  }
  let offset = 1
  const offsets: number[] = []
  while (!host.signal.aborted) {
    const page = await host.client.remote.workspaceFiles.read(sessionId, path, { offset }, host.signal)
    if (!page.ok && page.error.code === 'workspace-file/not-text') {
      await host.view.show(path, t.binary)
      await saveFile(host, path)
      return
    }
    const value = accepted(page)
    await host.view.show(`${path}:${offset}`, value.text)
    const action = await host.view.choose(path, [
      ...value.eof ? [] : [{ label: t.next, value: 'next' }],
      ...offsets.length === 0 ? [] : [{ label: t.previous, value: 'previous' }],
      { label: t.save, value: 'save' }, { label: t.back, value: 'back' },
    ])
    if (action === undefined || action === 'back') return
    if (action === 'save') await saveFile(host, path)
    if (action === 'next') { offsets.push(offset); offset += value.lines }
    if (action === 'previous') offset = offsets.pop() ?? 1
  }
}

/** Browse directories and view or save each selected file.
 * @param host - Current terminal services.
 */
export async function files(host: TerminalFeatureHost): Promise<void> {
  const sessionId = selected(host).sessionId
  let path = ''
  while (!host.signal.aborted) {
    const listing = accepted(await host.client.remote.workspaceFiles.list(sessionId, path, host.signal))
    const item = await host.view.choose<{ kind: 'path' } | { kind: 'parent' } | { kind: 'entry'; entry: typeof listing.entries[number] }>(`${t.files} /${listing.path}`, [
      { label: t.enterPath, value: { kind: 'path' as const } },
      ...listing.path === '' ? [] : [{ label: t.parent, value: { kind: 'parent' as const } }],
      ...listing.entries.map(entry => ({ label: `${entry.name}${entry.type === 'directory' ? '/' : ''}`, description: entry.size === undefined ? entry.type : `${entry.size} B`, value: { kind: 'entry' as const, entry } })),
    ])
    if (item === undefined) return
    if (item.kind === 'parent') { path = listing.path.split('/').slice(0, -1).join('/'); continue }
    if (item.kind === 'path') {
      const target = await host.view.input(t.path)
      if (target !== undefined) await document(host, target)
      continue
    }
    if (!('entry' in item)) continue
    const target = `${listing.path === '' ? '' : `${listing.path}/`}${item.entry.name}`
    if (item.entry.type === 'directory') path = target
    else {
      const action = await host.view.choose(target, [{ label: t.open, value: 'open' }, { label: t.save, value: 'save' }])
      if (action === 'open') await document(host, target)
      if (action === 'save') await saveFile(host, target)
    }
  }
}

const imageTypes = new Map<string, Extract<Parameters<SessionFace['prompt']>[0][number], { type: 'image' }>['mediaType']>([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'],
])

/** Submit supported local images through Session image admission, or upload other files as receipts.
 * Image previews remain owned by the pending submission until retirement.
 * @param host - Current terminal services.
 */
export async function upload(host: TerminalFeatureHost): Promise<void> {
  const session = selected(host)
  const path = await host.view.input(t.path)
  if (path === undefined) return
  const text = await host.view.input(t.uploadPrompt)
  if (text === undefined) return
  const name = basename(path)
  const mediaType = imageTypes.get(extname(path).toLowerCase())
  if (mediaType !== undefined) {
    const projection = accepted(await host.client.remote.session.projections({ sessionId: session.sessionId }, host.signal))
    const limits = projection?.values.imageLimits
    if (limits === undefined) throw new Error(t.unavailable)
    const maxBytes = Math.min(limits.maxImageBytes, limits.maxMessageImageBytes)
    const file = await open(path, 'r')
    let bytes: Buffer
    try {
      if ((await file.stat()).size > maxBytes) throw new Error(`${t.imageTooLarge} (${maxBytes} bytes)`)
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of file.createReadStream({ end: maxBytes, autoClose: false, signal: host.signal })) {
        length += chunk.length
        if (length > maxBytes) throw new Error(`${t.imageTooLarge} (${maxBytes} bytes)`)
        chunks.push(chunk)
      }
      bytes = Buffer.concat(chunks, length)
    } finally { await file.close() }
    const previewUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }))
    const submission = session.beginSubmission({
      text, mode: 'queue', attachments: [{ type: 'image', value: { previewUrl, name } }],
      onRetire: () => URL.revokeObjectURL(previewUrl),
    })
    try {
      accepted(await session.prompt([{ type: 'text', text }, { type: 'image', mediaType, data: bytes.toString('base64'), name }], 'queue', host.signal, submission.requestId))
    } catch (error) { submission.abandon(); throw error }
    return
  }
  const bytes = await readFile(path)
  const result = accepted(await host.client.fileUpload.upload(session.sessionId, bytes, name, host.signal))
  const submission = session.beginSubmission({ text, mode: 'queue', attachments: [{ type: 'file', value: result.file }] })
  try {
    accepted(await session.prompt([{ type: 'text', text }, { type: 'file', receiptId: result.receiptId }], 'queue', host.signal, submission.requestId))
  } catch (error) { submission.abandon(); throw error }
}

/** Stream a complete Host ZIP or Markdown export into a new local file.
 * @param host - Current terminal services.
 */
export async function exportSession(host: TerminalFeatureHost): Promise<void> {
  const sessionId = selected(host).sessionId
  const format = await host.view.choose(t.export, [{ label: 'ZIP', value: 'zip' }, { label: 'Markdown', value: 'markdown' }])
  if (format === undefined) return
  const destination = await host.view.input(t.exportPath, { initial: `${sessionId}.${format === 'zip' ? 'zip' : 'md'}` })
  if (destination === undefined) return
  const route = format === 'zip' ? 'api/session.export' : 'api/session.markdown'
  const response = await host.request(`${route}?${new URLSearchParams({ sessionId, ...format === 'zip' ? { includeDescendants: 'true' } : {} })}`, { signal: host.signal })
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
  const file = await open(destination, 'wx', 0o600)
  const reader = response.body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      await file.writeFile(chunk.value)
    }
  } catch (error) {
    await unlink(destination)
    throw error
  } finally {
    try { await reader.cancel() }
    finally { reader.releaseLock(); await file.close() }
  }
  await host.view.show(t.saved, destination)
}

const changeFile = z.object({ path: z.string(), display: z.string(), added: z.number().int(), deleted: z.number().int() })
const summarySchema = z.object({
  turn: z.number().int(), files: z.array(changeFile), total: z.number().int(), added: z.number().int(), deleted: z.number().int(),
})
const diffSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), display: z.string(), hunks: z.array(z.object({ oldStart: z.number().int(), oldLines: z.number().int(), newStart: z.number().int(), newLines: z.number().int(), lines: z.array(z.string()) })) }),
  z.object({ kind: z.enum(['binary', 'oversized']), display: z.string() }),
])

/** Open exact turn-start/end comparisons served by the Host's recorded changes.
 * @param host - Current terminal services.
 */
export async function diff(host: TerminalFeatureHost): Promise<void> {
  const sessionId = selected(host).sessionId
  const entries = host.client.sessions.binding(sessionId)?.eventSource.getSnapshot().entries ?? []
  const event = await host.view.choose(t.diff, entries.filter(entry => String(entry.event.type) === 'workspace/changes').map(entry => ({ label: `${entry.event.seq} ${details(entry.event.data)}`, value: entry.event })))
  if (event === undefined) return
  const query = new URLSearchParams({ sessionId, seq: String(event.seq) })
  const response = await host.request(`api/changes.summary?${query}`, { signal: host.signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const summary = summarySchema.parse(await response.json())
  const index = await host.view.choose(t.diff, summary.files.map((file, index) => ({ label: `${file.display} +${file.added} -${file.deleted}`, value: index })))
  if (index === undefined) return
  query.set('index', String(index))
  const comparison = await host.request(`api/changes.diff?${query}`, { signal: host.signal })
  if (!comparison.ok) throw new Error(`HTTP ${comparison.status}`)
  const value = diffSchema.parse(await comparison.json())
  await host.view.show(value.display, value.kind === 'text'
    ? value.hunks.map(hunk => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`).join('\n\n')
    : value.kind)
}

const presentedSchema = z.object({ files: z.array(z.object({ path: z.string(), description: z.string().optional() })) })

/** Browse declared deliverables and Host-recorded changed files in the retained history window.
 * Load older history before reopening this menu to include earlier turns.
 * @param host - Current terminal services.
 */
export async function deliverables(host: TerminalFeatureHost): Promise<void> {
  const sessionId = selected(host).sessionId
  const entries = host.client.sessions.binding(sessionId)?.eventSource.getSnapshot().entries ?? []
  const files: TerminalChoice<string>[] = []
  for (const { event } of entries) {
    if (String(event.type) === 'deliverables/presented') {
      files.push(...presentedSchema.parse(event.data).files.map(file => ({ label: `${t.declaredFile}: ${file.path}`, ...file.description === undefined ? {} : { description: file.description }, value: file.path })))
    }
    if (String(event.type) === 'workspace/changes') {
      const query = new URLSearchParams({ sessionId, seq: String(event.seq) })
      const response = await host.request(`api/changes.summary?${query}`, { signal: host.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const summary = summarySchema.parse(await response.json())
      files.push(...summary.files.map(file => ({ label: `${t.changedFile}: ${file.display}`, description: `+${file.added} -${file.deleted}`, value: file.path })))
    }
  }
  const file = await host.view.choose(t.deliverables, files)
  if (file !== undefined) await document(host, file)
}
