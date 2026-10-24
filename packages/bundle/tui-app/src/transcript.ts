/** Text presentation over the Client-owned, reconciled Session event window. */
import type { SessionEventLikeEntry, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ContentBlock, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { conversationText as t } from './conversation-locales.ts'

/** One terminal transcript block, independent of terminal width. */
export interface TranscriptRow {
  readonly key: string
  readonly kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'status'
  readonly title: string
  readonly text: string
}

/**
 * Strip terminal control sequences from untrusted model, tool, and user text.
 * @param text - remote or editable text before terminal presentation.
 * @returns plain text preserving newlines and tabs.
 */
export function terminalText(text: string): string {
  return text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text': case 'reasoning': return block.text
    case 'image': return `[image: ${block.attachment.name ?? block.attachment.attachmentId}]`
    case 'file': return `[file: ${block.attachment.name}]`
    default: return ''
  }
}

function liveDelta(chunk: StreamChunk): { kind: TranscriptRow['kind']; text: string; index: number } | undefined {
  switch (chunk.type) {
    case 'text-delta': return { kind: 'assistant', text: chunk.text, index: chunk.index }
    case 'reasoning-delta': return { kind: 'reasoning', text: chunk.text, index: chunk.index }
    case 'tool-call-delta': return { kind: 'tool', text: `${chunk.name ?? ''}${chunk.argumentsDelta}`, index: chunk.index }
    default: return undefined
  }
}

/**
 * Render the supplied window only. Reconciliation, history cropping, and stream settlement stay with ISessions.
 * @param entries - exact retained binding's event window.
 * @param snapshot - matching Session lifecycle and submission echoes.
 * @returns ordered width-independent transcript rows.
 */
export function transcriptRows(entries: readonly SessionEventLikeEntry[], snapshot: SessionSnapshot): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const live = new Map<string, number>()
  const add = (key: string, kind: TranscriptRow['kind'], title: string, text: string): void => {
    rows.push({ key, kind, title, text: terminalText(text) })
  }
  for (const entry of entries) {
    const event = entry.event
    const key = String(event.seq)
    switch (event.type) {
      case 'assistant/live-chunk': {
        const delta = liveDelta(event.data.chunk)
        if (delta === undefined) break
        const liveKey = `${event.data.attemptId}:${delta.index}`
        const index = live.get(liveKey)
        const row = index === undefined ? undefined : rows[index]
        if (row !== undefined && index !== undefined) rows[index] = { ...row, text: row.text + terminalText(delta.text) }
        else {
          live.set(liveKey, rows.length)
          add(liveKey, delta.kind, delta.kind === 'reasoning' ? t.reasoning : delta.kind === 'tool' ? t.tool : t.assistant, delta.text)
        }
        break
      }
      case 'user/message':
        add(key, 'user', t.you, event.data.content.map(blockText).filter(Boolean).join('\n'))
        break
      case 'assistant/message':
        event.data.message.content.forEach((block, index) => {
          if (block.type === 'tool-call') return
          add(`${key}:${index}`, block.type === 'reasoning' ? 'reasoning' : 'assistant',
            block.type === 'reasoning' ? t.reasoning : t.assistant, blockText(block))
        })
        if (event.data.interrupted) add(`${key}:interrupted`, 'status', t.interrupted, '')
        break
      case 'assistant/attempt':
        for (const record of event.data.stream) {
          if (record.type === 'text-chunks' || record.type === 'reasoning-chunks') {
            add(`${key}:${rows.length}`, record.type === 'text-chunks' ? 'assistant' : 'reasoning', t.interrupted, record.texts.join(''))
          } else if (record.type === 'tool-call-chunks') {
            add(`${key}:${rows.length}`, 'tool', `${t.interrupted} · ${record.name ?? t.tool}`, record.args.join(''))
          } else {
            const delta = liveDelta(record.chunk)
            if (delta !== undefined) add(`${key}:${rows.length}`, delta.kind, t.interrupted, delta.text)
          }
        }
        break
      case 'tool/call': add(key, 'tool', `${t.tool} · ${event.data.name}`, event.data.arguments); break
      case 'tool/result': add(key, 'tool', `${t.tool} · ${event.data.message.isError ? t.failed : event.data.message.toolCallId}`,
        event.data.message.content.map(blockText).filter(Boolean).join('\n')); break
      case 'command/run': add(key, 'status', `/${event.data.name}`, event.data.args ?? ''); break
      case 'command/done': if (event.data.text) add(key, 'status', event.data.kind, event.data.text); break
      default: break
    }
  }
  for (const submission of snapshot.pendingSubmissions) add(`pending:${submission.requestId}`, 'user',
    `${t.you} · ${submission.placement === 'steering' ? t.steer : submission.placement === 'queued' ? t.queue : t.pending}`, submission.text)
  return rows
}

/**
 * Sum reported usage for this retained window without extrapolating total Session usage.
 * @param entries - retained event window.
 * @returns reported input/output tokens in the window.
 */
export function windowUsage(entries: readonly SessionEventLikeEntry[]): Pick<TokenUsage, 'inputTokens' | 'outputTokens'> {
  let inputTokens = 0
  let outputTokens = 0
  for (const { event } of entries) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    inputTokens += event.data.usage.inputTokens + (event.data.usage.cacheReadTokens ?? 0) + (event.data.usage.cacheWriteTokens ?? 0)
    outputTokens += event.data.usage.outputTokens
  }
  return { inputTokens, outputTokens }
}
