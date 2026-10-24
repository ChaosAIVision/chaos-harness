/** Recorded Session-window behavior, without a model or a second history implementation. */
import { describe, expect, it } from 'vitest'
import { MutableSessionEventSource, type SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { LlmAttemptId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { terminalText, transcriptRows, windowUsage } from '../src/transcript.ts'

const snapshot: SessionSnapshot = {
  sessionId: SessionId('terminal-test'), pendingSubmissions: [], running: false, subagent: null,
  removed: false, openState: 'open', openError: null, hasMore: false, loadingOlder: false,
  promptError: null, blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
}

function user(seq: number, text: string): SessionEvent<'user/message'> {
  return { type: 'user/message', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
    data: { id: MessageId(`user-${seq}`), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

describe('terminal transcript', () => {
  it('keeps injected context distinct from human input while preserving its full text', () => {
    const injected = user(2, 'Runtime context\nFull recorded details')
    const rows = transcriptRows([
      { type: 'event', event: user(1, 'Human prompt') },
      { type: 'event', event: { ...injected, data: { ...injected.data, source: { kind: 'system-prompt' } } } },
    ], snapshot)
    expect(rows.map(row => [row.kind, row.text])).toEqual([
      ['user', 'Human prompt'], ['context', 'Runtime context\nFull recorded details'],
    ])
  })

  it('follows Client-owned live stream settlement without duplicating the assistant', () => {
    const source = new MutableSessionEventSource()
    const attemptId = LlmAttemptId('attempt')
    source.replace([{ type: 'event', event: user(1, 'Question') }], false)
    for (const text of ['Hello', ' world']) source.append({ type: 'transient', event: {
      type: 'assistant/live-chunk', seq: 2, time: 2,
      data: { attemptId, turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
    } })
    expect(transcriptRows(source.getSnapshot().entries, snapshot).map(row => row.text)).toEqual(['Question', 'Hello world'])
    const assistant: SessionEvent<'assistant/message'> = {
      type: 'assistant/message', seq: SessionSeq(3), time: 3, surfaceOp: 'append',
      data: { turn: 1, step: 1, stream: [], usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 },
        message: { id: MessageId('answer'), role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
          content: [{ type: 'text', text: 'Hello world' }] } },
    }
    source.settleAssistant(attemptId, { type: 'event', event: assistant })
    expect(transcriptRows(source.getSnapshot().entries, snapshot).map(row => row.text)).toEqual(['Question', 'Hello world'])
    expect(windowUsage(source.getSnapshot().entries)).toEqual({ inputTokens: 13, outputTokens: 4 })
    source.prepend([{ type: 'event', event: user(0, 'Older history') }], false)
    expect(transcriptRows(source.getSnapshot().entries, snapshot)[0]?.text).toBe('Older history')
  })

  it('preserves interrupted reasoning and text stored as compact attempt records', () => {
    const rows = transcriptRows([{ type: 'event', event: {
      type: 'assistant/attempt', seq: SessionSeq(2), time: 2, data: { turn: 1, step: 1, stream: [
        { type: 'reasoning-chunks', time0: 1, index: 0, dt: [1], texts: ['Think', ' carefully'] },
        { type: 'text-chunks', time0: 2, index: 1, dt: [], texts: ['Partial answer'] },
      ] },
    } }], snapshot)
    expect(rows.map(row => [row.kind, row.text])).toEqual([['reasoning', 'Think carefully'], ['assistant', 'Partial answer']])
  })

  it('removes OSC clipboard commands, CSI styling, and control characters from remote content', () => {
    expect(terminalText('\u001b]52;c;secret\u0007\u001b[31mSafe\u001b[0m\u0000\ntext')).toBe('Safe\ntext')
  })
})
