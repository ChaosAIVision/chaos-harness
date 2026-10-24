/** Supported dsh terminal profile and private owned-Host bridge. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseTerminalLaunch } from './startup.ts'
import { startTerminalHost } from './host.ts'
import * as HostBridge from './host-bridge.ts'
import type { TerminalClientEntry, TerminalLaunch } from './launch-types.ts'
import { runtimeCopy as t } from './runtime-copy.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-app'
/** The supported launcher supplies command arguments before activation. */
export const inject = ['cmdlineArgs']
/** Process lifecycle configuration, independently patchable from invocation flags. */
export interface Config {
  mode: 'terminal' | 'host-bridge'
  startupTimeoutMs: number
  shutdownTimeoutMs: number
}
/** Validated terminal and owned subprocess lifecycle configuration. */
export const Config: z<Config> = z.object({
  mode: z.union(['terminal', 'host-bridge']).default('terminal'),
  startupTimeoutMs: z.number().min(1).default(60_000),
  shutdownTimeoutMs: z.number().min(1).default(3_000),
})

async function run(launch: TerminalLaunch, config: Config, signal: AbortSignal): Promise<void> {
  const host = await startTerminalHost(launch, signal, config.startupTimeoutMs, config.shutdownTimeoutMs)
  try {
    const clientUrl = new URL(import.meta.url.endsWith('.ts') ? './client.ts' : './client.js', import.meta.url).href
    const client = await import(clientUrl) as TerminalClientEntry
    await client.run(host.connectUrl, launch, AbortSignal.any([signal, host.lost]), config.startupTimeoutMs)
    if (host.lost.aborted && !signal.aborted) throw new Error(t.ended)
  } finally {
    await host.stop()
  }
}

/**
 * Parse the terminal invocation or mount the child-only readiness bridge.
 * @param ctx - supported dsh profile Context.
 * @param config - validated lifecycle configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode === 'host-bridge') {
    ctx.plugin(HostBridge)
    return
  }
  const launch = parseTerminalLaunch(ctx)
  if (launch === undefined) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(t.terminal)
  const controller = new AbortController()
  const restore = (): void => {
    process.stdin.setRawMode(false)
    process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[0m')
  }
  let task: Promise<void> | undefined
  ctx.effect(() => {
    process.once('exit', restore)
    return async () => {
      controller.abort()
      await task
      process.off('exit', restore)
      restore()
    }
  }, 'tui.runtime')
  const ready = ctx.get('appReady')
  const begin = (): void => {
    task = run(launch, config, controller.signal).then(
      () => { ctx.get('appExit')?.(0) },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          restore()
          process.stderr.write(`${error instanceof Error ? error.message : t.launch}\n`)
          ctx.get('appExit')?.(1)
        }
      },
    )
  }
  if (ready === undefined) queueMicrotask(begin)
  else ctx.effect(() => ready.onReady(begin), 'tui.ready')
}
