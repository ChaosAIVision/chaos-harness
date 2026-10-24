/** Private readiness publication after real Loader and HTTP composition settle. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, vi } from 'vitest'
import * as HostBridge from '../src/host-bridge.ts'

it('publishes a working private URL only after sibling activation completes without adding a second shutdown owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tui-bridge-loader-'))
  const configPath = join(root, 'cordis.yml')
  const ready = Promise.withResolvers<undefined>()
  const messages: unknown[] = []
  const originalSend = process.send
  const originalConnected = Object.getOwnPropertyDescriptor(process, 'connected')
  process.send = (message) => { messages.push(message); return true }
  Object.defineProperty(process, 'connected', { value: true, configurable: true, writable: true })
  const ctx = new Context()
  const disconnectListeners = process.listenerCount('disconnect')
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include,
      credentials: LocalCredentials,
      webserver: WebServer,
      connection: Connection,
      bridge: HostBridge,
      delayed: { apply: async () => { await ready.promise } },
    })
    const rows = [
      { name: 'cordis:credentials', config: { path: join(root, 'credentials.yaml'), watch: false } },
      { id: 'webserver', name: 'cordis:webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'connection', name: 'cordis:connection' },
      { name: 'cordis:bridge' },
      { name: 'cordis:delayed' },
    ]
    await writeFile(configPath, rows.map(row => `- ${JSON.stringify(row)}`).join('\n') + '\n')
    const loading = ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await vi.waitFor(() => { expect(ctx.get('connection')).toBeDefined() })
    expect(messages).toEqual([])
    ready.resolve(undefined)
    await loading
    await ctx.loader.await()
    await vi.waitFor(() => { expect(messages).toHaveLength(1) })
    const message = messages[0]
    if (typeof message !== 'object' || message === null || !('connectUrl' in message) || typeof message.connectUrl !== 'string') {
      throw new Error('expected private readiness URL')
    }
    const target = new URL('connect', message.connectUrl)
    target.search = new URL(message.connectUrl).search
    target.searchParams.set('interactions', 'answer')
    const admission = await fetch(target, { redirect: 'manual' })
    expect(admission.status).toBe(302)
    expect(admission.headers.getSetCookie()).toHaveLength(1)
    expect(process.listenerCount('disconnect')).toBe(disconnectListeners)
  } finally {
    ready.resolve(undefined)
    await ctx.fiber.dispose()
    if (originalSend === undefined) Reflect.deleteProperty(process, 'send')
    else process.send = originalSend
    if (originalConnected === undefined) Reflect.deleteProperty(process, 'connected')
    else Object.defineProperty(process, 'connected', originalConnected)
    await rm(root, { recursive: true, force: true })
  }
  expect(process.listenerCount('disconnect')).toBe(disconnectListeners)
})
