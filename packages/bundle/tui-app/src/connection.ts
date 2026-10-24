/** Origin-scoped Node HTTP and WebSocket carrier with per-generation API admission. */
import WebSocket from 'ws'
import type { ConnectionWebSocket, ConnectionWebSocketFactory, RpcFetch } from '@deepseek-ai/dsh-client-connection/client'
import { runtimeCopy as t } from './runtime-copy.ts'

interface SocketEvents {
  readonly open: object
  readonly error: object
  readonly close: object
  readonly message: { readonly data: unknown }
}
interface SocketListener {
  readonly event: keyof SocketEvents
  readonly original: object
  readonly once: boolean
  readonly deliver: (event: { readonly data: unknown }) => void
}

class AdmittedSocket implements ConnectionWebSocket {
  private socket: WebSocket | undefined
  private state = 0
  private readonly listeners = new Set<SocketListener>()
  constructor(url: string, admission: Promise<string>, signal: AbortSignal) {
    const aborted = (): void => { this.close() }
    signal.addEventListener('abort', aborted, { once: true })
    this.addEventListener('close', () => { signal.removeEventListener('abort', aborted) }, { once: true })
    void admission.then((cookie) => {
      if (this.state !== 0 || signal.aborted) return
      const socket = new WebSocket(url, { headers: { cookie }, followRedirects: false })
      this.socket = socket
      socket.on('open', () => { this.state = 1; this.emit('open') })
      socket.on('message', (data) => {
        const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data
        this.emit('message', bytes.toString('utf8'))
      })
      socket.on('error', () => { this.emit('error') })
      socket.on('close', () => { this.state = 3; this.emit('close') })
    }, () => {
      if (this.state === 3) return
      this.emit('error')
      this.state = 3
      this.emit('close')
    })
    if (signal.aborted) this.close()
  }
  get readyState(): number { return this.state }
  send(data: string): void {
    if (this.state !== 1 || this.socket === undefined) throw new Error(t.ended)
    this.socket.send(data)
  }
  close(code?: number, reason?: string): void {
    if (this.state === 3) return
    this.state = 3
    if (this.socket === undefined) this.emit('close')
    else if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate()
    else this.socket.close(code, reason)
  }
  addEventListener<K extends keyof SocketEvents>(
    event: K, listener: (event: SocketEvents[K]) => void, options?: { readonly once?: boolean },
  ): void {
    this.listeners.add({ event, original: listener, once: options?.once === true, deliver: (value) => { listener(value) } })
  }
  removeEventListener<K extends keyof SocketEvents>(event: K, listener: (event: SocketEvents[K]) => void): void {
    for (const item of this.listeners) if (item.event === event && item.original === listener) this.listeners.delete(item)
  }
  private emit(event: keyof SocketEvents, data?: unknown): void {
    for (const item of [...this.listeners]) {
      if (item.event !== event) continue
      if (item.once) this.listeners.delete(item)
      item.deliver({ data })
    }
  }
}

/** Authenticated carrier consumed by the existing Connection and upload clients. */
export interface TerminalTransport {
  readonly baseUrl: string
  readonly fetch: RpcFetch
  readonly createWebSocket: ConnectionWebSocketFactory
}

/**
 * Exchange a private launch URL for an interactive API cookie without following redirects.
 * Cookies stay inside the selected origin and mount. Every socket generation readmits.
 * @param connectUrl - authenticated URL received privately or from an explicit file.
 * @param signal - complete terminal lifetime.
 * @returns transport with initial admission completed.
 */
export async function createTerminalTransport(connectUrl: string, signal: AbortSignal): Promise<TerminalTransport> {
  let url: URL
  try { url = new URL(connectUrl) } catch { throw new Error(t.url) }
  const tokens = url.searchParams.getAll('token')
  const token = tokens[0]
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || tokens.length !== 1 || token === undefined || token === '') throw new Error(t.url)
  const base = new URL(url.href)
  base.search = ''
  base.hash = ''
  base.pathname = base.pathname.replace(/\/connect\/?$/, '/')
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const exchange = new URL('connect', base)
  exchange.searchParams.set('token', token)
  exchange.searchParams.set('interactions', 'answer')
  let cookie: string | undefined
  let pending: Promise<string> | undefined
  let openedSocket = false
  const admit = (fresh: boolean): Promise<string> => {
    if (pending !== undefined) return pending
    if (!fresh && cookie !== undefined) return Promise.resolve(cookie)
    pending = (async () => {
      const response = await fetch(exchange, { redirect: 'manual', signal })
      const cookies = response.headers.getSetCookie()
      const issued = cookies.filter(value => /^dsh-auth-[A-Za-z0-9_-]+=/.test(value))
      const issuedCookie = issued[0]
      if (response.status !== 302 || issued.length !== 1 || issuedCookie === undefined) throw new Error(t.auth)
      cookie = issuedCookie.split(';', 1).join('')
      return cookie
    })().catch(() => { cookie = undefined; throw new Error(t.auth) }).finally(() => { pending = undefined })
    return pending
  }
  const scoped = (input: string | URL, websocket: boolean): URL => {
    const target = new URL(input, base)
    const compare = new URL(target.href)
    if (websocket) compare.protocol = compare.protocol === 'wss:' ? 'https:' : 'http:'
    if (compare.origin !== base.origin || !compare.pathname.startsWith(base.pathname) || target.username !== '' || target.password !== '') throw new Error(t.scope)
    return target
  }
  await admit(false)
  return {
    baseUrl: base.href,
    fetch: async (input, init) => {
      const target = scoped(input, false)
      const headers = new Headers(init.headers)
      headers.set('cookie', await admit(false))
      return fetch(target, { ...init, headers, redirect: 'manual', signal: init.signal === undefined || init.signal === null ? signal : AbortSignal.any([signal, init.signal]) })
    },
    createWebSocket: (input) => {
      const target = scoped(input, true)
      const admission = admit(openedSocket)
      openedSocket = true
      return new AdmittedSocket(target.href, admission, signal)
    },
  }
}
