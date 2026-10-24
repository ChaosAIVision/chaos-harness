/**
 * End-to-end check: a real headless session, a scripted LLM, one dispatch.
 *
 * The mock provider stands in for a model so the run is deterministic and
 * needs no API key. The scripted first response is a `claude_agent` call; every
 * later request is plain text. After the run this asserts that the parent
 * dispatch happened, that a child session was created, and that the child's
 * wire request carried the configured route and the agent declaration.
 *
 *   node --import tsx/esm packages/context/claude-compat/tests/e2e.ts
 *   E2E_MODEL_ROUTE=deepseek-official/deepseek-v4-flash node --import tsx/esm .../e2e.ts
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { startMockLlmServer } from '../../../test-support/llm-mock-server/src/index.ts'

const pluginPath = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const route = process.env.E2E_MODEL_ROUTE
const expectedModel = process.env.E2E_EXPECT_MODEL ?? route?.split('/')[1]
const toolArguments = JSON.stringify({
  subagent_type: 'pstack:comment-sicko',
  description: 'compat e2e',
  prompt: 'Reply with the single line COMPAT-OK and stop.',
})

// The overlay points at this checkout's source so the run never depends on the
// package being installed into the profile.
const [routeProvider, routeModel] = (route ?? '').split('/')
const modelsBlock = route === undefined
  ? ''
  : `\n        models:\n          '*': { provider: ${JSON.stringify(routeProvider)}, model: ${JSON.stringify(routeModel)} }`
const overlayDir = mkdtempSync(join(tmpdir(), 'claude-compat-e2e-'))
const overlay = join(overlayDir, 'overlay.yml')
writeFileSync(overlay, [
  '- insert:',
  '    - id: claude-compat',
  `      name: ${JSON.stringify(pluginPath)}`,
  '      config:',
  '        roots:',
  "          - '~/.agents/pstack-plugin'",
  '        provider: spawn',
  '        hooks: true',
  modelsBlock,
  '',
].join('\n'))

const server = await startMockLlmServer({
  port: 0,
  apiKey: 'mock-key',
  // One scripted tool call, then plain text: a repeated tool call would recurse
  // through the child and never terminate.
  sequence: ['tool_call_success', 'success'],
  repeatLast: true,
  toolName: 'claude_agent',
  toolArguments,
  successText: 'COMPAT-E2E-OK',
})

const env = {
  ...process.env,
  DEEPSEEK_BASE_URL: `${server.baseURL}/v1`,
  DEEPSEEK_API_KEY: 'mock-key',
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless', '--patch', overlay, '--json', 'Delegate now.'],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
)

/** One JSONL event emitted by `dsh --json`; only the fields this check reads. */
interface JsonEvent {
  readonly type?: string
  readonly tool?: string
  readonly status?: string
  readonly result?: string
  readonly sessionId?: string
  readonly text?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEvent(line: string): JsonEvent | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => { stdout += String(chunk) })
child.stderr.on('data', (chunk) => { stderr += String(chunk) })
const exitCode = await new Promise<number>((resolve) => {
  child.on('close', (code) => { resolve(code ?? -1) })
})

const events = stdout.split('\n').flatMap(line => parseEvent(line) ?? [])

const toolCall = events.find(event => event.type === 'tool_call')
const toolResult = events.find(event => event.type === 'tool_result')
const final = events.find(event => event.type === 'final')
const sessionId = events.find(event => event.type === 'session')?.sessionId ?? ''
const childIdMatch = /subagent ([0-9a-f-]{36})/.exec(toolResult?.result ?? '')
const childId = childIdMatch?.[1]

// The mock captured every wire request: the child's is the one carrying the persona.
const bodies = server.requests.map(record => record.body as {
  model?: string
  messages?: Array<{ content?: unknown }>
})
const childBody = bodies.find(body => JSON.stringify(body.messages ?? []).includes('Comment Sicko'))
const childModel = childBody?.model

await server.close()

// The child session on disk is the durable proof that a real child agent ran.
const sessionsRoot = join(process.env.HOME ?? '', '.dsh', 'sessions', '--Users-chaos-.local-share-chaos-harness--')
let childSessionHasPersona = false
if (childId !== undefined && existsSync(join(sessionsRoot, childId))) {
  const file = readdirSync(join(sessionsRoot, childId)).find(name => name.endsWith('.jsonl.zstd'))
  if (file !== undefined) {
    const raw = zstdDecompressSync(readFileSync(join(sessionsRoot, childId, file))).toString()
    childSessionHasPersona = raw.includes('Comment Sicko') && raw.includes('COMPAT-OK')
  }
}

const report = {
  ok: exitCode === 0
    && toolCall?.tool === 'claude_agent'
    && toolResult?.status === 'completed'
    && childId !== undefined
    && childSessionHasPersona
    && server.requests.length >= 2
    && (expectedModel === undefined || childModel === expectedModel),
  exitCode,
  parentSession: sessionId,
  toolCall: toolCall ?? null,
  toolResult: toolResult?.result ?? null,
  childSession: childId ?? null,
  childSessionHasPersona,
  childWireModel: childModel ?? null,
  expectedModel: expectedModel ?? '(inherit)',
  requests: server.requests.length,
  finalText: final?.text ?? null,
  stderr: stderr.trim().split('\n').slice(-3),
}

console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
