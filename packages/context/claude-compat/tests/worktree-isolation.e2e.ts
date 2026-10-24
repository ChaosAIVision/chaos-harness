/** Keyless shipped-profile coverage of real Git leases and nested parent delivery. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { it } from 'vitest'
import { git, repository } from '../../../experimental/worktree/tests/harness.ts'

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

async function runScenario(cancel: boolean): Promise<void> {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url))
  const temporary = mkdtempSync(join(tmpdir(), 'compat-worktree-'))
  const project = await repository(temporary)
  const outside = join(temporary, 'non-git')
  mkdirSync(outside)
  mkdirSync(join(project, 'untracked-subdir'))
  const home = join(temporary, 'dsh')
  const root = join(temporary, 'pstack')
  mkdirSync(join(root, 'hooks'), { recursive: true })
  writeFileSync(join(root, 'hooks/session-start-context.md'), 'ISOLATION_MANDATE')
  const sheet = join(temporary, 'models.md')
  writeFileSync(sheet, 'default effort: session\n')
  const requests: Record<string, unknown>[] = []
  const launched = new Set<string>()
  const cases = cancel ? ['DIRTY'] : ['CLEAN', 'DIRTY', 'PARALLEL_A', 'PARALLEL_B', 'DEGRADED', 'FAILED', 'RESIDENT']
  let cancelReady: () => void = () => {}
  const cancellationReady = new Promise<void>((resolve) => { cancelReady = resolve })
  const activeParallel = new Set<string>()
  let releaseParallel: () => void = () => {}
  const parallelReady = new Promise<void>((resolve) => { releaseParallel = resolve })
  const call = (marker: string, cwd?: string): Block => ({ type: 'tool_use', id: `call-${marker}`, name: 'claude_agent', input: {
    description: `Isolation ${marker}`, prompt: `ISOLATED_TASK_${marker}`, ...marker === 'RESIDENT' ? {} : { isolation: 'worktree' }, ...cwd === undefined ? {} : { cwd },
  } })
  // oxlint-disable-next-line typescript/no-misused-promises -- Each request contains and reports asynchronous failures.
  const server = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push(body)
      const messages = JSON.stringify(body.messages)
      const marker = messages.includes('ISOLATION_ROOT') ? undefined : [...cases, 'NESTED_DIRTY'].find(value => messages.includes(`ISOLATED_TASK_${value}`))
      let content: Block[]
      if (marker !== undefined) {
        if (cancel && marker === 'DIRTY' && launched.has('write-DIRTY')) {
          cancelReady()
          await new Promise<void>(resolve => response.once('close', resolve))
          return
        }
        if (marker.startsWith('PARALLEL')) {
          activeParallel.add(marker)
          if (activeParallel.size === 2) releaseParallel()
          await parallelReady
        }
        if (marker === 'RESIDENT' && !launched.has('resident')) {
          launched.add('resident')
          content = [call('NESTED_DIRTY')]
        } else if ((marker === 'DIRTY' || marker === 'NESTED_DIRTY') && !launched.has(`write-${marker}`)) {
          launched.add(`write-${marker}`)
          content = [{ type: 'tool_use', id: 'write-evidence', name: 'write', input: { file_path: 'child-evidence.txt', content: 'kept-child-evidence\n' } }]
        } else content = [{ type: 'text', text: `ANSWER_${marker}` }]
      } else if (!launched.has('root')) {
        launched.add('root')
        content = cases.map(value => call(value, value === 'DEGRADED' ? outside : value === 'FAILED' ? 'untracked-subdir' : undefined))
      } else content = [{ type: 'text', text: 'ISOLATION_ROOT_DONE' }]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (value: { type: string; [key: string]: unknown }) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
      send({ type: 'message_start', message: { id: 'msg-isolation', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } })
      for (const [index, block] of content.entries()) {
        send({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
        send({ type: 'content_block_stop', index })
      }
      send({ type: 'message_delta', delta: { stop_reason: content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
      send({ type: 'message_stop' })
      response.end()
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const patch = join(temporary, 'isolation.yml')
    writeFileSync(patch, [
      { insert: [{ id: 'worktrees', name: join(repo, 'packages/experimental/worktree/src/index.ts'), config: { baseRef: 'head' } }], before: 'claude-compat' },
      { id: 'agent-default-model', config: { provider: 'isolation-mock', model: 'mock-model' } },
      { id: 'llm-pi-ai', config: { providers: { 'isolation-mock': { api: 'anthropic-messages', baseURL: `http://127.0.0.1:${address.port}`, apiKeyEnv: 'ISOLATION_MOCK_KEY', models: [{ id: 'mock-model' }] } } } },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'claude-compat', config: { roots: [], hooks: false, pstack: { root, sheetPath: sheet } } },
    ].map(value => `- ${JSON.stringify(value)}`).join('\n'))
    const launch = resolveExampleLaunch({ srcBin: join(repo, 'apps/cli/src/bin.ts'), tsconfigPath: join(repo, 'tsconfig.json'), configArgs: ['--profile', 'headless', '--patch', patch, '--json', 'ISOLATION_ROOT'], env: {
      DSH_HOME: home, DSH_AGENTS_HOME: join(temporary, 'agents'), DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1', ISOLATION_MOCK_KEY: 'keyless', DEEPSEEK_API_KEY: '',
    } })
    const child = spawn(launch.command, launch.args, { cwd: project, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
    const completion = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    let code: number | null
    try {
      if (cancel) await Promise.race([cancellationReady.then(() => { child.kill('SIGTERM') }), completion.then(() => { throw new Error(`process exited before cancellation probe: ${stderr}`) })])
      code = await completion
    } finally {
      clearTimeout(timer)
    }
    assert.equal(code, 0, `${stderr}\n${stdout}`)
    const logs: string[] = []
    const collect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) collect(path)
        else if (entry.name.endsWith('.jsonl')) logs.push(readFileSync(path, 'utf8'))
      }
    }
    collect(join(home, 'sessions'))
    const parent = logs.find((log) => {
      const header = JSON.parse(log.split('\n')[0]!) as { parentSession?: string }
      return header.parentSession === undefined
    })
    assert.ok(parent, `missing parent log\n${stdout}`)
    if (cancel) {
      const checkouts = (await git(project, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9))
      assert.equal(checkouts.length, 2, 'cancelled dirty checkout was lost or duplicated')
      const keptPath = checkouts.find(path => path !== project)
      assert.ok(keptPath && existsSync(join(keptPath, 'child-evidence.txt')), 'cancelled child evidence was lost')
      const common = await git(project, 'rev-parse', '--git-common-dir')
      const admin = join(project, common, 'worktrees')
      const leases = readdirSync(admin).map(name => JSON.parse(readFileSync(join(admin, name, 'dsh-lease.json'), 'utf8')) as { state: string })
      assert.deepEqual(leases.map(lease => lease.state), ['kept'], `cancelled lease settlement did not finish\n${stderr}`)
      return
    }
    const resultTexts = [...parent.matchAll(/Worktree isolation: cwd=([^ ]+) branch=([^ ]+)/g)]
    const paths = [...new Set(resultTexts.map(match => match[1]!))]
    assert.equal(paths.length, 4, `expected four successful Git leases\n${parent}`)
    const kept = paths.filter(path => existsSync(join(path, 'child-evidence.txt')))
    assert.equal(kept.length, 1, 'dirty child evidence not retained exactly once')
    assert.equal(readFileSync(join(kept[0]!, 'child-evidence.txt'), 'utf8'), 'kept-child-evidence\n')
    for (const path of paths.filter(path => !kept.includes(path))) assert.equal(existsSync(path), false, `clean checkout retained ${path}`)
    assert.equal(existsSync(join(project, 'child-evidence.txt')), false, 'parent cwd moved')
    assert.equal((await git(project, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 3, 'failed activation leaked a checkout')
    assert.equal((await git(project, 'branch', '--list', 'dsh/lease/*')).split('\n').filter(Boolean).length, 2, 'clean or failed activation leaked a branch')
    assert.ok(parent.includes('Worktree isolation unavailable:') && parent.includes(outside), 'degraded isolation is not visible')
    assert.ok(parent.includes('ANSWER_CLEAN') && parent.includes('ANSWER_DIRTY') && parent.includes('ANSWER_DEGRADED'), 'child answers missing')
    const received = parent.split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; data?: { source?: { kind?: string } } })
    const keptIndex = received.findIndex(event => event.type === 'user/message' && event.data?.source?.kind === 'worktree-kept')
    const answerIndex = received.findIndex(event => event.type === 'user/message' && JSON.stringify(event).includes('ANSWER_DIRTY'))
    assert.ok(answerIndex >= 0 && keptIndex > answerIndex, 'kept notice must follow the dirty child answer')
    const resident = logs.find(log => JSON.stringify(JSON.parse(log.split('\n')[0]!)).includes('parentSession') && log.includes('ISOLATED_TASK_RESIDENT'))
    assert.ok(resident, 'resident parent never ran')
    assert.ok(resident.includes('ANSWER_NESTED_DIRTY'), 'nested answer never reached resident parent')
    const residentEvents = resident.split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; data?: { source?: { kind?: string } } })
    const nestedAnswer = residentEvents.findIndex(event => event.type === 'user/message' && JSON.stringify(event).includes('ANSWER_NESTED_DIRTY'))
    const nestedKept = residentEvents.findIndex(event => event.type === 'user/message' && event.data?.source?.kind === 'worktree-kept')
    assert.ok(nestedAnswer >= 0 && nestedKept > nestedAnswer, 'nested kept notice must reach its resident parent after the answer')
    assert.equal(activeParallel.size, 2, 'parallel children did not overlap')
    assert.ok(requests.some(body => JSON.stringify(body.messages).includes('Worktree kept')), 'kept notice never reached the parent model')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    rmSync(temporary, { recursive: true, force: true })
  }
}

it('isolates children through the headless Loader with clean, kept, degraded, parallel, failed, and nested activations', () => runScenario(false), 60_000)
it('settles a dirty isolated child before root cancellation tears down the profile', () => runScenario(true), 60_000)
