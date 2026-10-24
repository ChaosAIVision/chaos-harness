/** Keyless shipped-profile regression: panel dispatch, wire routing, and parent result delivery. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { it } from 'vitest'

it('routes a keyless pstack panel through headless and returns all child results to its parent', async () => {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url))
  const temporary = mkdtempSync(join(tmpdir(), 'pstack-panel-'))
  const home = join(temporary, 'dsh')
  const root = join(temporary, 'pstack')
  const requests: { route: string; body: Record<string, unknown> }[] = []
  const cases = [
    { type: 'general-purpose', alias: 'route-a', route: 'panel-a', effort: 'low', marker: 'PANEL_A_RESULT' },
    { type: 'general-purpose', alias: 'route-b', route: 'panel-b', effort: 'medium', marker: 'PANEL_B_RESULT' },
    { type: 'general-purpose', alias: 'route-c', route: 'panel-c', effort: 'high', marker: 'PANEL_C_RESULT' },
    { type: 'pstack:poteto-agent-high', alias: 'route-a', route: 'panel-a', effort: 'high', marker: 'NAMED_EFFORT_RESULT' },
    { type: 'pstack:effort-low', alias: 'inherit-parent', route: 'panel-parent', effort: 'low', marker: 'INHERITED_ROUTE_RESULT' },
    { type: 'general-purpose', alias: 'inherit-parent', route: 'panel-parent', effort: 'high', marker: 'INHERITED_EFFORT_RESULT' },
  ]
  let launched = false
  let judged = false
  const judge = { type: 'general-purpose', alias: 'route-c', route: 'panel-c', effort: 'high', marker: 'READONLY_JUDGE_RESULT' }
  const activeChildren = new Set<string>()
  let peakChildren = 0
  let releasePanel: () => void = () => {}
  const panelReady = new Promise<void>((resolve) => { releasePanel = resolve })
  // oxlint-disable-next-line typescript/no-misused-promises -- The request handler catches and reports every asynchronous failure.
  const server = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      const body = JSON.parse(raw) as Record<string, unknown>
      const route = request.url?.split('/')[1] ?? ''
      requests.push({ route, body })
      const messages = JSON.stringify(body.messages)
      const child = messages.includes('Run the configured review panel.') ? undefined : [...cases, judge].find(entry => messages.includes(`TASK_${entry.marker}`))
      if (child !== undefined) {
        activeChildren.add(child.marker)
        peakChildren = Math.max(peakChildren, activeChildren.size)
        if (cases.slice(0, 3).some(entry => entry.marker === child.marker)) {
          if (cases.slice(0, 3).every(entry => activeChildren.has(entry.marker))) releasePanel()
          await panelReady
        }
      }
      const panelComplete = cases.every(entry => messages.includes(`Its closing message:${entry.marker}`))
      const content = child !== undefined
        ? [{ type: 'text', text: child.marker }]
        : !launched
          ? cases.map((entry, index) => ({ type: 'tool_use', id: `panel-call-${index}`, name: 'claude_agent', input: {
            subagent_type: entry.type, description: `Panel runner ${index}`, prompt: `TASK_${entry.marker}`, model: entry.alias,
            ...entry.marker === 'INHERITED_EFFORT_RESULT' ? { reasoning_effort: entry.effort } : {},
          } }))
          : panelComplete && !judged
            ? [{ type: 'tool_use', id: 'judge-call', name: 'claude_agent', input: {
              subagent_type: judge.type, description: 'Readonly panel cross judge', prompt: `TASK_${judge.marker}\nCompare these results: ${cases.map(entry => entry.marker).join(', ')}`, model: judge.alias, readonly: true,
            } }]
            : [{ type: 'text', text: 'Panel results received.' }]
      if (child === undefined && panelComplete) judged = true
      if (child === undefined) launched = true
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (value: { type: string; [key: string]: unknown }) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
      send({ type: 'message_start', message: { id: 'msg-panel', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } })
      for (const [index, block] of content.entries()) {
        send({ type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify('input' in block ? block.input : {}) } : { type: 'text_delta', text: 'text' in block ? block.text : '' } })
        send({ type: 'content_block_stop', index })
      }
      send({ type: 'message_delta', delta: { stop_reason: content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
      send({ type: 'message_stop' })
      response.end()
      if (child !== undefined) activeChildren.delete(child.marker)
    } catch (error) {
      response.writeHead(500).end(String(error))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    mkdirSync(join(root, 'agents'), { recursive: true })
    mkdirSync(join(root, 'hooks'), { recursive: true })
    mkdirSync(join(root, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, '.claude-plugin/plugin.json'), '{"name":"pstack"}')
    writeFileSync(join(root, 'agents/poteto-agent.md'), '---\nname: poteto-agent\ndescription: Panel reviewer\n---\nNAMED_PERSONA\n')
    mkdirSync(join(root, 'effort-agents'), { recursive: true })
    writeFileSync(join(root, 'effort-agents/poteto-agent-high.md'), '---\nname: poteto-agent-high\neffort: high\n---\nNAMED_PERSONA\n')
    writeFileSync(join(root, 'effort-agents/effort-low.md'), '---\nname: effort-low\neffort: low\n---\nEFFORT_PERSONA\n')
    writeFileSync(join(root, 'hooks/session-start-context.md'), 'PANEL_ROOT_MANDATE\n')
    const sheet = join(temporary, 'models.md')
    writeFileSync(sheet, 'panel vendors: any\ndefault effort: session\nsession hook: on\n')
    const providers = Object.fromEntries(['panel-parent', 'panel-a', 'panel-b', 'panel-c'].map(route => [route, {
      api: 'anthropic-messages', baseURL: `http://127.0.0.1:${address.port}/${route}`, apiKeyEnv: 'PANEL_MOCK_KEY',
      models: [{ id: `${route}-model`, reasoning: true, compat: { forceAdaptiveThinking: true }, reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } }],
      reasoning: 'medium',
    }]))
    const aliases = Object.fromEntries(cases.slice(0, 3).map(entry => [entry.alias, { provider: entry.route, model: `${entry.route}-model`, reasoningEffort: entry.effort }]))
    const patch = join(temporary, 'panel.yml')
    writeFileSync(patch, [
      { id: 'agent-default-model', config: { provider: 'panel-parent', model: 'panel-parent-model', reasoningEffort: 'medium' } },
      { id: 'llm-pi-ai', config: { providers } },
      { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
      { id: 'session-title-llm', disabled: true },
      { id: 'subagent-model-selection-settings', config: {
        enabled: true, allowedModels: Object.keys(providers).map(provider => ({ provider, model: `${provider}-model` })),
      } },
      { id: 'claude-compat', config: {
        roots: [root], hooks: false, modelSelection: false, modelAliases: aliases, pstack: { root, sheetPath: sheet },
      } },
    ].map(value => `- ${JSON.stringify(value)}`).join('\n'))
    const launch = resolveExampleLaunch({ srcBin: join(repo, 'apps/cli/src/bin.ts'), tsconfigPath: join(repo, 'tsconfig.json'), configArgs: ['--profile', 'headless', '--patch', patch, '--json', 'Run the configured review panel.'], env: {
      DSH_HOME: home, DSH_AGENTS_HOME: join(temporary, 'agents'), DSH_TELEMETRY_DISABLED: '1', PANEL_MOCK_KEY: 'keyless-panel', DEEPSEEK_API_KEY: '',
    } })
    const child = spawn(launch.command, launch.args, { cwd: repo, env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000)
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() =>{  clearTimeout(timer) })
    assert.equal(code, 0, stderr)
    assert.ok(peakChildren >= 3, `panel did not overlap: peak=${peakChildren}`)
    for (const entry of [...cases, judge]) {
      const wire = requests.find(record => JSON.stringify(record.body.messages).includes(`TASK_${entry.marker}`) && !JSON.stringify(record.body.messages).includes('Run the configured review panel.'))
      assert.ok(wire, `missing actual child request for ${entry.type}/${entry.alias}\n${stdout}\n${stderr}`)
      assert.equal(wire.route, entry.route)
      assert.equal(wire.body.model, `${entry.route}-model`)
      assert.equal((wire.body.output_config as { effort?: string } | undefined)?.effort, entry.effort, JSON.stringify(wire.body))
      assert.equal(JSON.stringify(wire.body.messages).includes('NAMED_PERSONA'), entry.type === 'pstack:poteto-agent-high')
      assert.ok(!JSON.stringify(wire.body.messages).includes('PANEL_ROOT_MANDATE'))
      assert.ok(requests.some(record => record.route === 'panel-parent' && JSON.stringify(record.body.messages).includes('PANEL_ROOT_MANDATE') && JSON.stringify(record.body.messages).includes(`Its closing message:${entry.marker}`)), `parent never received ${entry.marker}`)
    }
    const judgeWire = requests.find(record => !JSON.stringify(record.body.messages).includes('Run the configured review panel.') && JSON.stringify(record.body.messages).includes(`TASK_${judge.marker}`))
    assert.ok(judgeWire, 'readonly judge did not run after panel')
    const tools = judgeWire.body.tools as { name: string }[]
    assert.ok(tools.some(tool => tool.name === 'read'), 'readonly judge lost read tool')
    assert.ok(!tools.some(tool => tool.name === 'write' || tool.name === 'edit'), 'readonly judge can mutate files')
    const logs: string[] = []
    function collect(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) collect(path)
        else if (entry.name.endsWith('.jsonl')) logs.push(readFileSync(path, 'utf8'))
      }
    }
    collect(join(home, 'sessions'))
    assert.ok(logs.length >= 8, `expected parent + seven durable children, got ${logs.length}`)
    assert.ok(logs.some(log => log.includes('Run the configured review panel.') && [...cases, judge].every(entry => log.includes(entry.marker))), 'parent results not durable')
    console.log(JSON.stringify({
      ok: true, children: cases.length + 1, peakChildren, requests: requests.length,
      sessions: logs.length, routes: [...new Set(requests.map(record => record.route))],
    }))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
    rmSync(temporary, { recursive: true, force: true })
  }
}, 60_000)
