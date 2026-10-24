/** Keyless shipped-profile coverage for home-scoped pstack configuration across working directories. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { it } from 'vitest'

type WireRequest = { route: string; body: Record<string, unknown> }
type ToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type Text = { type: 'text'; text: string }
const repo = fileURLToPath(new URL('../../../../', import.meta.url))

async function fixture(authorize = true) {
  const temporary = mkdtempSync(join(tmpdir(), 'pstack-global-'))
  const home = join(temporary, 'home')
  const agentsHome = join(temporary, 'agents')
  const root = join(agentsHome, 'pstack-plugin')
  const requests: WireRequest[] = []
  let respond: (request: WireRequest) => (ToolUse | Text)[] = () => [{ type: 'text', text: 'Ready.' }]
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += String(chunk) })
    request.on('end', () => {
      try {
        const wire = { route: request.url?.split('/')[1] ?? '', body: JSON.parse(raw) as Record<string, unknown> }
        requests.push(wire)
        const content = respond(wire)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (value: Record<string, unknown>) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
        send({ type: 'message_start', message: { id: 'msg-global', type: 'message', role: 'assistant', model: wire.body.model, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } })
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
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const profile = join(home, 'profiles', 'headless')
  initProfile(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  // Only transport/storage fixtures: compat and its policy must come from shipped composition.
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    { id: 'agent-default-model', config: { provider: 'global-parent', model: 'parent-model' } },
    { id: 'llm-pi-ai', config: { providers: Object.fromEntries(['global-parent', 'global-review', 'global-blocked'].map(provider => [provider, {
      api: 'anthropic-messages', baseURL: `http://127.0.0.1:${address.port}/${provider}`, apiKeyEnv: 'GLOBAL_MOCK_KEY',
      models: [{ id: provider === 'global-parent' ? 'parent-model' : 'review-model' }],
    }])) } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'session-title-llm', disabled: true },
    { insert: [{ id: 'test-human-answerer', name: fileURLToPath(new URL('./fixtures/pstack-human-answerer.mjs', import.meta.url)), config: { authorize, recordPath: join(home, 'approval.jsonl') } }] },
  ].map(value => `- ${JSON.stringify(value)}`).join('\n') + '\n')
  const directories = [join(temporary, 'unrelated-a'), join(temporary, 'unrelated-b')]
  for (const cwd of directories) mkdirSync(cwd)
  function installRoot() {
    mkdirSync(join(root, 'agents'), { recursive: true })
    mkdirSync(join(root, 'hooks'), { recursive: true })
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name":"pstack"}\n')
    writeFileSync(join(root, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Global reviewer\n---\nGLOBAL_NAMED_PERSONA\n')
    writeFileSync(join(root, 'hooks', 'session-start-context.md'), 'GLOBAL_ROOT_MANDATE\n')
  }
  async function launch(cwd: string, task: string, dumpWeb = false) {
    const launch = resolveExampleLaunch({ srcBin: join(repo, 'apps/cli/src/bin.ts'), tsconfigPath: join(repo, 'tsconfig.json'),
      configArgs: dumpWeb ? ['--profile', 'web', '--dump-config'] : ['--profile', 'headless', '--json', task],
      env: { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome, DSH_TELEMETRY_DISABLED: '1', GLOBAL_MOCK_KEY: 'keyless', DEEPSEEK_API_KEY: '' },
    })
    assert.ok(!launch.args.includes('--patch'))
    const child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 35_000)
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => { clearTimeout(timer) })
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.deepEqual(readdirSync(cwd), [], 'launch must not require or create repo-local configuration')
    return { stdout, stderr }
  }
  return { home, root, requests, directories, installRoot, launch,
    respond(handler: typeof respond) { respond = handler },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
      rmSync(temporary, { recursive: true, force: true })
    },
  }
}

function sessionLogs(home: string): string[] {
  const logs: string[] = []
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.name.endsWith('.jsonl')) logs.push(readFileSync(path, 'utf8'))
    }
  }
  collect(join(home, 'sessions'))
  return logs
}

it('persists setup and loads named and generic authorized routes from two unrelated working directories', async () => {
  const f = await fixture()
  try {
    f.installRoot()
    const filename = join(f.home, 'pstack', 'config.json')
    mkdirSync(join(f.home, 'pstack'), { recursive: true })
    // Operator authorization is deliberately separate from model-authored setup.
    const allowedModels = [{ provider: 'global-review', model: 'review-model' }]
    const blocked = { provider: 'global-blocked', model: 'review-model' }
    writeFileSync(filename, JSON.stringify({ version: 1, root: f.root, modelAliases: {}, roles: { default: 'inherit-parent' }, allowedModels: [] }))
    const modelAliases = { review: { provider: 'global-review', model: 'review-model' } }
    const roles = { feature: 'review', panel: 'review,inherit-parent' }
    let setupSent = false
    f.respond(() => {
      if (setupSent) return [{ type: 'text', text: 'Setup saved.' }]
      setupSent = true
      return [{ type: 'tool_use', id: 'save-global-setup', name: 'claude_agent_setup', input: { preferences_json: JSON.stringify({ modelAliases, roles }) } }]
    })
    await f.launch(f.directories[0]!, 'SAVE_GLOBAL_SETUP')
    const saved = JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>
    assert.deepEqual(saved.modelAliases, modelAliases)
    assert.deepEqual(saved.roles, { default: 'inherit-parent', ...roles })
    assert.deepEqual(saved.allowedModels, allowedModels)
    const approval = readFileSync(join(f.home, 'approval.jsonl'), 'utf8')
    assert.ok(approval.includes('global-review/review-model'), 'setup bypassed the real human question seam')
    assert.ok(!approval.includes('global-blocked'), 'approval asked for an unselected route')
    writeFileSync(filename, JSON.stringify({ ...saved, modelAliases: { ...modelAliases, blocked } }))
    assert.ok(sessionLogs(f.home).some(log => log.includes('Saved ') && log.includes('config.json')), 'setup did not report durable successful persistence')

    for (const cwd of f.directories) {
      const start = f.requests.length
      let dispatched = false
      f.respond((wire) => {
        const messages = JSON.stringify(wire.body.messages)
        if (!messages.includes('CHECK_GLOBAL_ROUTES')) return [{ type: 'text', text: 'GLOBAL_CHILD_RESULT' }]
        if (!dispatched) {
          dispatched = true
          return [
            { type: 'tool_use', id: 'global-catalog', name: 'claude_agent_models', input: {} },
            ...['general-purpose', 'pstack:reviewer'].map((type, index): ToolUse => ({ type: 'tool_use', id: `global-route-${index}`, name: 'claude_agent', input: {
              subagent_type: type, description: `Global review ${index}`, prompt: `GLOBAL_CHILD_TASK_${index}`, model: 'review',
            } })),
            { type: 'tool_use', id: 'blocked-route', name: 'claude_agent', input: { subagent_type: 'general-purpose', description: 'Unauthorized route probe', prompt: 'BLOCKED_CHILD_TASK', model: 'blocked' } },
          ]
        }
        return [{ type: 'text', text: 'Routes checked.' }]
      })
      await f.launch(cwd, 'CHECK_GLOBAL_ROUTES')
      const wires = f.requests.slice(start)
      const initial = JSON.stringify(wires[0]?.body.messages)
      assert.ok(initial.includes('GLOBAL_ROOT_MANDATE'), 'shipped compat failed to load home-scoped mandate')
      assert.ok(initial.includes('feature: review') && initial.includes('panel: review,inherit-parent'), 'fresh session did not load saved role sheet')
      assert.ok(initial.includes('review ->') || initial.includes('review'), 'saved aliases missing from first request')
      for (let index = 0; index < 2; index++) {
        const child = wires.find(wire => !JSON.stringify(wire.body.messages).includes('CHECK_GLOBAL_ROUTES') && JSON.stringify(wire.body.messages).includes(`GLOBAL_CHILD_TASK_${index}`))
        assert.ok(child, `no actual child wire request for ${index}; parent tool results: ${JSON.stringify(wires.at(-1)?.body.messages).slice(-6000)}`)
        assert.equal(child.route, 'global-review')
        assert.equal(child.body.model, 'review-model')
        assert.equal(JSON.stringify(child.body.messages).includes('GLOBAL_NAMED_PERSONA'), index === 1)
        assert.ok(!JSON.stringify(child.body.messages).includes('GLOBAL_ROOT_MANDATE'), 'root mandate leaked into child')
      }
      assert.ok(!wires.some(wire => wire.route === 'global-blocked'), 'unauthorized alias reached the provider')
      const parentResults = JSON.stringify(wires.filter(wire => wire.route === 'global-parent').map(wire => wire.body.messages))
      assert.ok(parentResults.includes('GLOBAL_CHILD_RESULT'), 'parent did not receive child result')
      assert.ok(parentResults.includes('"allowed":true') || parentResults.includes('\\"allowed\\":true'), 'discovery did not expose allowed policy')
      assert.ok(parentResults.includes('"allowed":false') || parentResults.includes('\\"allowed\\":false'), 'discovery did not expose denied policy')
    }
    const logs = sessionLogs(f.home)
    assert.ok(logs.some(log => log.includes('subagent/model-selection-policy') && log.includes('global-review')), 'route authorization was not recorded in the fresh Session')
    const persisted: unknown = JSON.parse(readFileSync(filename, 'utf8'))
    assert.ok(typeof persisted === 'object' && persisted !== null && 'allowedModels' in persisted)
    assert.deepEqual(persisted.allowedModels, allowedModels, 'setup changed operator authorization')
  } finally {
    await f.close()
  }
}, 90_000)

it('resolves shipped Web compat from either unrelated cwd without a command-line patch', async () => {
  const f = await fixture()
  try {
    f.installRoot()
    for (const cwd of f.directories) {
      const { stdout } = await f.launch(cwd, '', true)
      assert.ok(stdout.includes('@deepseek-ai/dsh-claude-compat'), 'shipped Web composition does not mount compat')
      assert.ok(!stdout.includes('test-human-answerer'), 'headless fixture leaked into Web composition')
    }
  } finally {
    await f.close()
  }
}, 45_000)

it('leaves configuration untouched when the human declines new route authorization', async () => {
  const f = await fixture(false)
  try {
    f.installRoot()
    let sent = false
    f.respond(() => {
      if (sent) return [{ type: 'text', text: 'Setup declined.' }]
      sent = true
      return [{ type: 'tool_use', id: 'declined-setup', name: 'claude_agent_setup', input: { preferences_json: JSON.stringify({
        modelAliases: { review: { provider: 'global-review', model: 'review-model' } }, roles: { feature: 'review' },
      }) } }]
    })
    await f.launch(f.directories[0]!, 'DECLINE_GLOBAL_SETUP')
    assert.ok(readFileSync(join(f.home, 'approval.jsonl'), 'utf8').includes('global-review/review-model'))
    assert.ok(!existsSync(join(f.home, 'pstack', 'config.json')), 'declined setup persisted preferences or authorization')
    assert.ok(sessionLogs(f.home).some(log => log.includes('not authorized by the user')), 'declined approval did not report failure')
  } finally {
    await f.close()
  }
}, 45_000)

it('auto-loads an installed pstack without configuration and delegates only on the inherited route', async () => {
  const f = await fixture()
  try {
    f.installRoot()
    let dispatched = false
    f.respond((wire) => {
      const messages = JSON.stringify(wire.body.messages)
      if (!messages.includes('UNSET_INSTALLED_HOME')) return [{ type: 'text', text: 'INHERITED_CHILD_RESULT' }]
      if (dispatched) return [{ type: 'text', text: 'Inherited safely.' }]
      dispatched = true
      return [{ type: 'tool_use', id: 'inherit-unset', name: 'claude_agent', input: { description: 'Inherited review', prompt: 'UNSET_CHILD_TASK', model: 'inherit-parent' } }]
    })
    await f.launch(f.directories[0]!, 'UNSET_INSTALLED_HOME')
    assert.ok(JSON.stringify(f.requests[0]?.body.messages).includes('GLOBAL_ROOT_MANDATE'))
    assert.ok(JSON.stringify(f.requests[0]?.body.messages).includes('inherit-parent'))
    const child = f.requests.find(wire => JSON.stringify(wire.body.messages).includes('UNSET_CHILD_TASK') && !JSON.stringify(wire.body.messages).includes('UNSET_INSTALLED_HOME'))
    assert.ok(child, 'installed pstack did not delegate with safe inherited defaults')
    assert.equal(child.route, 'global-parent')
    assert.equal(child.body.model, 'parent-model')
    assert.ok(!existsSync(join(f.home, 'pstack', 'config.json')), 'safe defaults must not persist authorization')
  } finally {
    await f.close()
  }
}, 45_000)

it('boots safely with no installed pstack and no home configuration', async () => {
  const f = await fixture()
  try {
    await f.launch(f.directories[0]!, 'UNCONFIGURED_HOME')
    assert.ok(f.requests.length > 0)
    assert.ok(!JSON.stringify(f.requests).includes('GLOBAL_ROOT_MANDATE'))
    assert.ok(!existsSync(join(f.home, 'pstack', 'config.json')), 'an ordinary session must not silently authorize routes')
  } finally {
    await f.close()
  }
}, 45_000)
