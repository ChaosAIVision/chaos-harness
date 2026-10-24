/** Real HTTP and WebSocket carrier isolation, admission, and cancellation. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createTerminalTransport } from '../src/connection.ts'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function server(admission: 'accept' | 'reject' | 'pending' = 'accept') {
  const admissions: string[] = []
  const calls: string[] = []
  const sockets: string[] = []
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    if (url.pathname === '/mount/connect') {
      admissions.push(url.search)
      if (admission === 'pending') return
      if (admission === 'reject') { res.writeHead(401); res.end(); return }
      res.writeHead(302, { 'set-cookie': `dsh-auth-fixture=peer${admissions.length}; HttpOnly; Path=/`, location: './api/remote.mux' })
      res.end()
    } else {
      calls.push(req.headers.cookie ?? '')
      res.end('accepted')
    }
  })
  const ws = new WebSocketServer({ server: http })
  ws.on('connection', (socket, request) => {
    sockets.push(request.headers.cookie ?? '')
    socket.on('message', (data) => { socket.send(data) })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('expected TCP listener')
  const base = `http://127.0.0.1:${address.port}/mount/`
  cleanup.push(async () => {
    for (const client of ws.clients) client.terminate()
    await new Promise<void>((resolve) => { ws.close(() => { resolve() }) })
    http.closeAllConnections()
    await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
  })
  return { base, admissions, calls, sockets }
}
function open(socket: ConnectionWebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => { resolve() }, { once: true })
    socket.addEventListener('error', () => { reject(new Error('socket failed')) }, { once: true })
  })
}
function close(socket: ConnectionWebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.addEventListener('close', () => { resolve() }, { once: true })
    socket.close()
  })
}

describe('Node terminal transport', () => {
  it('uses the same interactive cookie for HTTP and WebSocket, then readmits after loss', async () => {
    const fixture = await server()
    const controller = new AbortController()
    const transport = await createTerminalTransport(`${fixture.base}?token=private`, controller.signal, 1000)
    expect(fixture.admissions).toEqual(['?token=private&interactions=answer'])
    expect(await (await transport.fetch('api/commands.list', {})).text()).toBe('accepted')
    const socket = transport.createWebSocket(fixture.base.replace('http:', 'ws:') + 'api/remote.mux')
    await open(socket)
    const echo = new Promise<unknown>((resolve) => { socket.addEventListener('message', (event) => { resolve(event.data) }, { once: true }) })
    socket.send('echo')
    expect(await echo).toBe('echo')
    expect(fixture.calls).toEqual(['dsh-auth-fixture=peer1'])
    expect(fixture.sockets).toEqual(['dsh-auth-fixture=peer1'])
    await close(socket)
    const next = transport.createWebSocket(fixture.base.replace('http:', 'ws:') + 'api/remote.mux')
    await open(next)
    await transport.fetch('api/commands.list', {})
    expect(fixture.admissions).toHaveLength(2)
    expect(fixture.sockets.at(-1)).toBe('dsh-auth-fixture=peer2')
    expect(fixture.calls.at(-1)).toBe('dsh-auth-fixture=peer2')
    const closed = new Promise<void>((resolve) => { next.addEventListener('close', () => { resolve() }, { once: true }) })
    controller.abort()
    await closed
    expect(next.readyState).toBe(3)
  })

  it('never forwards cookies outside the selected origin or mount', async () => {
    const fixture = await server()
    const transport = await createTerminalTransport(`${fixture.base}?token=private`, new AbortController().signal, 1000)
    await expect(transport.fetch('http://127.0.0.1:1/mount/api', {})).rejects.toThrow('authenticated Host')
    await expect(transport.fetch('../outside', {})).rejects.toThrow('authenticated Host')
    expect(() => transport.createWebSocket('ws://127.0.0.1:1/mount/api')).toThrow('authenticated Host')
    expect(fixture.calls).toEqual([])
  })

  it('bounds a stalled exchange and reports rejection without credentials', async () => {
    const pending = await server('pending')
    await expect(createTerminalTransport(`${pending.base}?token=private`, new AbortController().signal, 20)).rejects.toThrow('Host rejected')
    const rejected = await server('reject')
    await expect(createTerminalTransport(`${rejected.base}?token=private`, new AbortController().signal, 1000)).rejects.toThrow('Host rejected')
  })

  it('rejects malformed authentication without exposing the supplied URL', async () => {
    await expect(createTerminalTransport('file:///secret?token=hidden', new AbortController().signal, 1000)).rejects.toThrow('HTTP(S)')
    await expect(createTerminalTransport('https://user:secret@example.test/?token=hidden', new AbortController().signal, 1000)).rejects.toThrow('HTTP(S)')
    await expect(createTerminalTransport('http://127.0.0.1/?token=one&token=two', new AbortController().signal, 1000)).rejects.toThrow('HTTP(S)')
  })
})
