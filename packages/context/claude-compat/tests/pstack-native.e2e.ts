/** Keyless profile smoke: native pstack context and configured alias reach the wire and session log. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { it } from 'vitest'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { scanZstdFrames } from '../../../session/session-persistence-jsonl/src/zstd.ts'
import { startMockLlmServer } from '../../../test-support/llm-mock-server/src/index.ts'

it('loads native pstack context and dispatches the configured alias through the Loader', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pstack-native-e2e-'))
  const home = join(temporary, 'home')
  const agentsHome = join(temporary, 'agents')
  const root = join(temporary, 'pstack')
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'hooks'), { recursive: true })
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin/plugin.json'), '{"name":"pstack"}')
  writeFileSync(join(root, 'agents/poteto-agent.md'), '---\nname: poteto-agent\ndescription: Test agent\n---\nNATIVE-PERSONA-PROBE\n')
  writeFileSync(join(root, 'hooks/session-start-context.md'), 'NATIVE-MANDATE-PROBE\n')
  const sheet = join(temporary, 'models.md')
  writeFileSync(sheet, 'feature, refactoring: fast\npanel vendors: any\ndefault effort: session\nsession hook: on\n')
  const overlay = join(temporary, 'overlay.yml')
  writeFileSync(overlay, [
    '- id: subagent-model-selection-settings',
    '  config:',
    '    enabled: true',
    '    allowedModels: [{ provider: deepseek-official, model: deepseek-v4-flash }]',
    '- id: claude-compat',
    '  config:',
    `    roots: [${JSON.stringify(root)}]`,
    '    provider: spawn',
    '    hooks: false',
    '    modelSelection: false',
    '    modelAliases:',
    '      fast: { provider: deepseek-official, model: deepseek-v4-flash }',
    `    pstack: { root: ${JSON.stringify(root)}, sheetPath: ${JSON.stringify(sheet)} }`,
  ].join('\n'))
  const server = await startMockLlmServer({
    port: 0, apiKey: 'mock-key', sequence: ['tool_call_success', 'success'], repeatLast: true,
    toolName: 'claude_agent',
    toolArguments: JSON.stringify({ subagent_type: 'pstack:poteto-agent', description: 'Native alias probe', prompt: 'Reply NATIVE-CHILD-OK.', model: 'fast' }),
    successText: 'NATIVE-CHILD-OK',
  })
  try {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'headless', '--patch', overlay, '--json', 'Delegate now.'], {
      env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_BASE_URL: `${server.baseURL}/v1`, DEEPSEEK_API_KEY: 'mock-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    }).finally(() => { clearTimeout(timer) })
    assert.equal(code, 0, stderr)
    const bodies = server.requests.map(record => record.body as { model?: string; messages?: unknown[] })
    assert.ok(JSON.stringify(bodies[0]?.messages).includes('NATIVE-MANDATE-PROBE'), 'first request lacks mandate')
    assert.ok(JSON.stringify(bodies[0]?.messages).includes('feature, refactoring: fast'), 'first request lacks sheet')
    assert.ok(JSON.stringify(bodies[0]?.messages).includes('claude_agent'), 'first request lacks tool adaptation')
    const childBody = bodies.find(body => JSON.stringify(body.messages).includes('NATIVE-PERSONA-PROBE'))
    assert.ok(childBody, 'no native child request')
    assert.equal(childBody.model, 'deepseek-v4-flash')
    assert.ok(!JSON.stringify(childBody.messages).includes('NATIVE-MANDATE-PROBE'), 'child must not receive root mandate')
    const events = stdout.split('\n').filter(line => line.startsWith('{')).map((line) => {
      const value: unknown = JSON.parse(line)
      if (typeof value !== 'object' || value === null) throw new Error('Expected JSON event object')
      return {
        type: 'type' in value && typeof value.type === 'string' ? value.type : undefined,
        sessionId: 'sessionId' in value && typeof value.sessionId === 'string' ? value.sessionId : undefined,
      }
    })
    const ids = new Set(events.filter(event => event.type === 'session').map(event => event.sessionId).filter(id => id !== undefined))
    const sessionsRoot = join(home, 'sessions')
    const logs = readdirSync(sessionsRoot).flatMap(workspace =>
      [...ids].flatMap((id) => {
        const directory = join(sessionsRoot, workspace, id)
        if (!existsSync(directory)) return []
        const file = readdirSync(directory).find(name => name.endsWith('.jsonl.zstd'))
        if (file === undefined) return []
        const bytes = readFileSync(join(directory, file))
        const frames = scanZstdFrames(bytes).frames.map(({ start, end }) => zstdDecompressSync(bytes.subarray(start, end)))
        const log = Buffer.concat(frames).toString()
        const header: unknown = JSON.parse(log.split('\n')[0]!)
        return typeof header === 'object' && header !== null && !('parentSession' in header) ? [log] : []
      }),
    )
    assert.equal(logs.length, 1, 'expected one top-level durable session')
    const log = logs[0]!
    assert.ok(log.includes('NATIVE-MANDATE-PROBE') && log.includes('feature, refactoring: fast'), 'context not durable')
    console.log(JSON.stringify({
      ok: true, firstRequestContext: true, durableContext: true,
      childModel: childBody.model, childRootMandate: false, requests: bodies.length,
    }))
  } finally {
    await server.close()
    rmSync(temporary, { recursive: true, force: true })
  }
}, 45_000)
