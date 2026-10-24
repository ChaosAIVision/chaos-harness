/** Private readiness handoff from an owned Web Host to its terminal parent. */
import type { Context } from '@deepseek-ai/cordis'
import { auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Cordis services required before the authenticated handoff. */
export const inject = ['connection', 'webServer', 'loader']

/**
 * Publish credentials only on the inherited IPC channel after Loader settlement.
 * @param ctx - child Web Host Context.
 */
export function apply(ctx: Context): void {
  if (process.send === undefined || !process.connected) throw new Error('tui host bridge requires parent IPC')
  const exit = ctx.get('appExit')
  void ctx.loader.await().then(async () => {
    await auditStartupEntries(ctx.root, 'dsh tui host', () => {})
    if (!process.connected || ctx.get('connection') === undefined) return
    process.send?.({ kind: 'tui-host-ready', connectUrl: ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()) })
  }).catch(() => { exit?.(1) })
}
