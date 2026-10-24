/** Terminal profile command parsing. Help never starts a Host or claims stdin. */
import { resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import type { TerminalLaunch } from './launch-types.ts'
import { runtimeCopy as t } from './runtime-copy.ts'

/**
 * Parse the launcher's argument snapshot into a terminal invocation.
 * @param ctx - launcher Context providing cmdlineArgs and appExit.
 * @returns accepted arguments, or undefined after help or a usage error.
 */
export function parseTerminalLaunch(ctx: Context): TerminalLaunch | undefined {
  let launch: TerminalLaunch | undefined
  const program = new Command().name('dsh tui').description(t.description)
    .helpOption('-h, --help', t.help)
    .option('--connect-url-file <path>', t.connect)
    .option('--host-profile <name>', t.profile, 'web')
    .option('--cwd <path>', t.cwd, process.cwd())
    .option('--resume <id>', t.resume)
    .option('--load', t.load)
    .option('--preset <name>', t.preset)
  program.action(() => {
    const options = program.opts<{
      connectUrlFile?: string
      hostProfile: string
      cwd: string
      resume?: string
      load?: boolean
      preset?: string
    }>()
    if ([options.resume !== undefined, options.load === true, options.preset !== undefined].filter(Boolean).length > 1) {
      program.error(t.incompatible)
    }
    launch = {
      cwd: resolve(options.cwd),
      initial: options.resume !== undefined ? { kind: 'session', sessionId: options.resume }
        : options.load === true ? { kind: 'picker' }
          : { kind: 'new', ...(options.preset === undefined ? {} : { preset: options.preset }) },
      host: options.connectUrlFile === undefined
        ? { kind: 'owned', profile: options.hostProfile }
        : { kind: 'attached', connectUrlFile: resolve(options.connectUrlFile) },
    }
  })
  parseCmdline(ctx, program)
  return launch
}
