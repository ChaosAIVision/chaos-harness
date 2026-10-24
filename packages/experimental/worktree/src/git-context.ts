/** Git commands bound to one sandbox policy, working directory, and cancellation signal. */

import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { runCommand } from './process.ts'
import type { ProcessConfig } from './process.ts'

/** Fully defaulted service configuration. */
export interface ResolvedConfig extends ProcessConfig {
  directory: string
  namePrefix: string
  gitCommand: string
  nodeCommand: string
  baseRef: 'remote-default' | 'head'
}

/** The mounted providers and resolved configuration every worktree operation runs against. */
export interface Runtime {
  readonly ctx: Context
  readonly config: ResolvedConfig
}

export type CommandResult = Awaited<ReturnType<typeof runCommand>>

export interface GitContext {
  readonly policy: SandboxExecutionPolicy
  readonly cwd: string
  readonly signal: AbortSignal
  readonly git: (directory: string, args: string[], allowedExitCodes?: number[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>
  readonly node: (directory: string, script: string, ...args: string[]) => Promise<CommandResult>
}

/**
 * Bind Git and Node invocations to a policy. Git always runs with hooks and fsmonitor disabled.
 * @param runtime - providers and configuration.
 * @param policy - sandbox policy of the calling Session.
 * @param cwd - default directory for repository discovery.
 * @param signal - cancellation of every command.
 */
export function bindGit(runtime: Runtime, policy: SandboxExecutionPolicy, cwd: string, signal: AbortSignal): GitContext {
  const { ctx, config } = runtime
  const exec = (directory: string, argv: [string, ...string[]], allowedExitCodes?: number[], env?: NodeJS.ProcessEnv) => runCommand(
    ctx, config, policy, directory, argv, signal, allowedExitCodes, env,
  )
  return {
    policy, cwd, signal,
    git: (directory, args, allowedExitCodes, env) => exec(
      directory, [config.gitCommand, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], allowedExitCodes, env,
    ),
    node: (directory, script, ...args) => exec(directory, [config.nodeCommand, '--input-type=module', '-e', script, ...args]),
  }
}

/** A Git work tree with at least one commit. */
export interface Repository {
  root: string
  head: string
}

/**
 * Locate the repository containing the context's directory.
 * @returns the canonical root and HEAD commit, or why the directory cannot be isolated.
 */
export async function repository(runtime: Runtime, git: GitContext): Promise<Repository | { reason: string }> {
  const { fs } = runtime.ctx
  const top = await git.git(git.cwd, ['rev-parse', '--show-toplevel'], [0, 128])
  if (top.exitCode !== 0) {
    if (/not a git repository|must be run in a work tree/i.test(top.stderr)) return { reason: `${git.cwd} is not inside a Git work tree` }
    throw new Error(`worktree command failed (128): ${top.stderr.trim()}`)
  }
  const target = await fs.resolve(top.stdout.replace(/\r?\n$/, ''), { cwd: git.cwd, signal: git.signal })
  const root = fs.processPath(target)
  const head = await git.git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], [0, 1])
  if (head.exitCode !== 0) return { reason: `${root} has no commits` }
  return { root, head: head.stdout.trim() }
}
