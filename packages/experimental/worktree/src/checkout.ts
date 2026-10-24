/** Branch and checkout creation shared by retained worktrees and delegate leases. */

import { PREPARE_DIRECTORY } from './directory.ts'
import type { CommandResult, GitContext, Runtime } from './git-context.ts'
import type { CreatedWorktree } from './types.ts'

/** Fresh branch name and the local revision its checkout starts from. */
export interface WorktreeSpec {
  branch: string
  revision: string
}

/** Reads Git configuration in a directory that selects the repository whose filters apply. */
export type ConfigReader = (args: string[], allowedExitCodes: number[]) => Promise<CommandResult>

/**
 * Environment overrides that disable every configured clean, smudge, process, and required filter driver.
 * @param configure - reads filter configuration from the checkout's repository.
 * @returns Git configuration overrides for every discovered filter driver.
 */
export async function filterOverrides(configure: ConfigReader): Promise<NodeJS.ProcessEnv> {
  const configured = await configure(['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], [0, 1])
  const drivers = new Set<string>()
  for (const key of configured.stdout.split('\0')) {
    const separator = key.lastIndexOf('.')
    if (separator > 'filter.'.length && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
      drivers.add(key.slice('filter.'.length, separator))
    }
  }
  const overrides: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
  let index = 0
  for (const driver of drivers) {
    for (const attribute of ['clean', 'smudge', 'process', 'required']) {
      overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
      overrides[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
      index++
    }
  }
  return overrides
}

/**
 * Describe a failed creation whose checkout or branch may remain on disk.
 * @param branch - branch allocated for the checkout.
 * @param path - allocated checkout directory.
 * @param error - failure retained as the cause.
 * @returns an error identifying the retained artifacts and underlying failure.
 */
export function incomplete(branch: string, path: string, error: unknown): Error {
  return new Error(`Could not finish worktree ${branch} at ${path}. Any created checkout and branch are retained. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}

/**
 * Create the branch and checkout for a spec. The caller's working directory is never changed.
 * @param runtime - mounted providers and resolved worktree configuration.
 * @param git - caller's directory, cancellation, and execution policy.
 * @param spec - fresh branch name and locally resolvable revision.
 * @param onAdded - runs once Git has registered the worktree and before its files are written.
 * @returns the canonical checkout path, new branch, resolved commit, and repository root.
 */
export async function checkout(
  runtime: Runtime,
  git: GitContext,
  spec: WorktreeSpec,
  onAdded?: (path: string) => Promise<void>,
): Promise<CreatedWorktree> {
  const { branch, revision } = spec
  const { fs } = runtime.ctx
  const { cwd, signal } = git
  const run = git.git
  await run(cwd, ['check-ref-format', `refs/heads/${branch}`])
  const rootOutput = await run(cwd, ['rev-parse', '--show-toplevel'])
  const rootTarget = await fs.resolve(rootOutput.stdout.replace(/\r?\n$/, ''), { cwd, signal })
  const repositoryRoot = fs.processPath(rootTarget)
  const base = await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])
  const baseCommit = base.stdout.trim()
  const existing = await run(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
  if (existing.exitCode === 0) throw new Error(`worktree branch already exists: ${branch}`)
  const pool = await fs.resolve(runtime.config.directory, { cwd: repositoryRoot, signal })
  const poolPath = fs.processPath(pool)
  const destination = await fs.resolve(branch, { cwd: poolPath, signal })
  const path = fs.processPath(destination)
  if (await fs.lstat(path, undefined, signal) !== undefined) throw new Error(`worktree path already exists: ${path}`)
  try {
    await git.node(repositoryRoot, PREPARE_DIRECTORY, poolPath, path)
    await run(repositoryRoot, ['--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', branch, '--', path, baseCommit])
    await onAdded?.(path)
    const env = await filterOverrides((args, allowed) => run(path, args, allowed))
    await run(path, ['--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', baseCommit], undefined, env)
    return { path: fs.processPath(await fs.resolve(path, { signal })), branch, baseCommit, repositoryRoot }
  } catch (error) {
    throw incomplete(branch, path, error)
  }
}
