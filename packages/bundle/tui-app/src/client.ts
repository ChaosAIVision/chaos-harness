/** Node terminal Client assembly, compiled separately from the Host launcher. */
import { Context } from '@deepseek-ai/cordis'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import * as Typert from '@deepseek-ai/dsh-typert-registry/client'
import * as Gateway from '@deepseek-ai/dsh-api-gateway/client'
import * as Remotes from '@deepseek-ai/dsh-api-remotes/client'
import { installFileUpload } from '@deepseek-ai/dsh-client-file-upload/client'
import * as Terminals from '@deepseek-ai/dsh-api-terminal-controller/client'
import * as Sessions from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createTerminalTransport } from './connection.ts'
import { runTerminalApp } from './app.ts'
import type { TerminalLaunch } from './launch-types.ts'

/**
 * Mount the existing Client services and run one terminal presentation lifetime.
 * @param connectUrl - private authenticated Web Host URL.
 * @param launch - accepted terminal navigation inputs.
 * @param signal - process and owned Host lifetime.
 * @param admissionTimeoutMs - configured timeout for each credential exchange.
 */
export async function run(
  connectUrl: string, launch: TerminalLaunch, signal: AbortSignal, admissionTimeoutMs: number,
): Promise<void> {
  const transport = await createTerminalTransport(connectUrl, signal, admissionTimeoutMs)
  const client = new Context()
  try {
    installConnection(client, {
      interactions: 'answer',
      location: { hostname: new URL(transport.baseUrl).hostname },
      transport: { fetch: transport.fetch, createWebSocket: transport.createWebSocket, streamBaseUrl: transport.baseUrl },
    })
    client.provide('terminalRequests', { fetch: transport.fetch })
    await client.plugin(Typert)
    await client.plugin(Gateway)
    await client.plugin(Remotes)
    await installFileUpload(client, { fetch: transport.fetch })
    await client.plugin(Sessions)
    await client.plugin(Terminals)
    signal.throwIfAborted()
    await runTerminalApp(client, {
      cwd: launch.cwd,
      initial: launch.initial.kind === 'session' ? { kind: 'session', sessionId: SessionId(launch.initial.sessionId) } : launch.initial,
      signal,
    })
  } finally {
    await client.fiber.dispose()
  }
}
