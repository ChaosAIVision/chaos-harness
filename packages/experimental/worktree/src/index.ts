/** Creates Git worktrees: retained and entered on request, or leased to a delegate and settled when it stops. */

import { randomUUID } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { PREPARE_DIRECTORY, WRITE_FILE } from './directory.ts'
import { classify, decide, decideOrphan, isLeaseBranch, isReservedName, LEASE_PREFIX, parseLeaseFile, parseStatus, parseWorktreeList, reapAction, stashedFrom } from './lease.ts'
import type { Inspection, LeaseFile } from './lease.ts'
import { currentOwner, HOST, ownerAlive } from './owner.ts'
import { runCommand } from './process.ts'
import type { ProcessConfig } from './process.ts'
import type {
  CreatedWorktree, CreateWorktreeRequest, IsolatedActivation, Isolation, KeptReason, KeptReport, LeaseStatus, LeaseSummary, Settlement,
} from './types.ts'

export type {
  CreatedWorktree, CreateWorktreeRequest, IsolatedActivation, Isolation, KeptReason, KeptReport, LeaseStatus, LeaseSummary, Settlement,
} from './types.ts'
export { formatKept } from './lease.ts'

/** Worktree location, generated names, executables, and subprocess resource limits. */
export interface Config {
  /** Relative checkout pool inside the source repository. */
  directory?: string
  /** Prefix for automatically generated branch and checkout names. */
  namePrefix?: string
  /** Executable name or absolute execution-world path of a Git release that honors `GIT_NO_LAZY_FETCH`. */
  gitCommand?: string
  /** Node executable used for sandboxed directory allocation. */
  nodeCommand?: string
  /** Deadline in milliseconds for one command. */
  timeoutMs?: number
  /** Subprocess termination grace in milliseconds. */
  graceMs?: number
  /** Maximum captured bytes per subprocess output stream. */
  maxOutputBytes?: number
  /**
   * Revision that delegate leases start from. `remote-default` uses the local `origin/HEAD` target without
   * fetching and falls back to `HEAD`; `head` uses the caller's `HEAD`.
   */
  baseRef?: 'remote-default' | 'head'
}

type ResolvedConfig = Required<Config> & ProcessConfig

interface WorktreeSpec {
  branch: string
  revision: string
}

type CommandResult = Awaited<ReturnType<typeof runCommand>>
type ConfigReader = (args: string[], allowedExitCodes: number[]) => Promise<CommandResult>

/** Commands bound to one sandbox policy, working directory, and cancellation signal. */
interface GitContext {
  readonly policy: SandboxExecutionPolicy
  readonly cwd: string
  readonly signal: AbortSignal
  readonly git: (directory: string, args: string[], allowedExitCodes?: number[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>
  readonly node: (directory: string, script: string, ...args: string[]) => Promise<CommandResult>
}

/** A lease checkout together with its parsed metadata and admin directory. */
interface LeaseRef {
  path: string
  branch: string
  adminDir: string
  file: LeaseFile
}

/** Per-call options of {@link WorktreeService.isolate}. */
export interface IsolateRequest {
  /** Source repository directory; relative paths resolve against the agent's current directory. Omission uses that directory. */
  cwd?: string
}

/** Result of {@link WorktreeService.isolate}. */
export interface Isolated<T extends IsolatedActivation> {
  /** The value returned by the caller's start function. */
  activation: T
  isolation: Isolation
  /** Resolves after settlement and kept-report delivery; never rejects. Undefined when settlement failed. */
  settled: Promise<Settlement | undefined>
}

const LEASE_FILE = 'dsh-lease.json'

declare module '@deepseek-ai/cordis' {
  interface Context {
    worktrees: WorktreeService
  }
}

/** Reject path traversal independently of Git's branch-name grammar. */
function relativePath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.includes(':')
    && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

/** Creates retained Git worktrees and settled delegate leases under the mounted filesystem and sandbox providers. */
export class WorktreeService extends Service {
  static inject = ['workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    directory: z.string().default('.agents/worktrees'),
    namePrefix: z.string().default('worktree-'),
    gitCommand: z.string().default('git'),
    nodeCommand: z.string().default('node'),
    timeoutMs: z.number().default(60_000),
    graceMs: z.number().default(3_000),
    maxOutputBytes: z.number().default(65_536),
    baseRef: z.union([z.const('remote-default'), z.const('head')]).default('remote-default'),
  })

  private readonly config: ResolvedConfig
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<CreatedWorktree>>()
  private exclusion: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'worktrees')
    this.config = config as ResolvedConfig
    if (!relativePath(this.config.directory)) throw new Error('worktree: directory must be a relative directory without dot segments')
    if (!relativePath(`${this.config.namePrefix}name`) || this.config.namePrefix.startsWith('-')) {
      throw new Error('worktree: namePrefix must produce a relative branch name')
    }
    if (isReservedName(`${this.config.namePrefix}name`)) throw new Error(`worktree: namePrefix must not use the reserved ${LEASE_PREFIX} namespace`)
    for (const key of ['gitCommand', 'nodeCommand'] as const) {
      if (this.config[key].trim().length === 0) throw new Error(`worktree: ${key} must not be empty`)
    }
    for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
        throw new Error(`worktree: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
      }
    }
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('worktree service disposed'))
      await Promise.allSettled(this.pending)
    })
  }

  /**
   * Create a fresh branch and checkout at a pinned local revision, then enter it.
   * Existing branches or checkout paths fail. Uncommitted files stay in the source checkout.
   * Checkout disables configured clean, smudge, and process filters without changing Git config.
   * Repository-local replacement refs still apply; baseCommit reports the resolved object name.
   * The new checkout becomes current only after Git setup succeeds. Failures may retain newly
   * allocated Git/filesystem artifacts; no branch or checkout is removed automatically.
   * @param agent - caller whose current directory selects the source repository and file policy.
   * @param request - optional new name and local revision; defaults are generated name and HEAD.
   * @param signal - cancellation of lookup, creation, and working-directory publication.
   * @returns canonical checkout path, branch name, pinned commit, and source repository root.
   */
  async create(agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal): Promise<CreatedWorktree> {
    const operationSignal = this.operation(signal)
    const operation = this.createCheckout(agent, this.resolve(request), operationSignal)
    this.pending.add(operation)
    try {
      return await operation
    } finally {
      this.pending.delete(operation)
    }
  }

  private resolve(request: CreateWorktreeRequest): WorktreeSpec {
    const branch = request.name ?? `${this.config.namePrefix}${randomUUID()}`
    if (!relativePath(branch) || branch.startsWith('-')) throw new Error('worktree name must be a relative Git branch name')
    if (isReservedName(branch)) throw new Error(`worktree name must not use the reserved ${LEASE_PREFIX} namespace`)
    const revision = request.from ?? 'HEAD'
    if (revision.length === 0) throw new Error('worktree from must name a local commit, branch, or tag')
    return { branch, revision }
  }

  /**
   * Run a delegate in a private worktree and settle it when the delegate stops.
   * The caller's working directory never changes. A clean checkout is removed with its branch; one with
   * edits, commits, or a moved HEAD is kept and reported through `onKept`. Outside a Git work tree, or in a
   * repository without commits, the delegate runs in the caller's directory and `isolation` says why.
   * Leases whose owning process died are settled first. A lease owned by a live process, or by another host, is never touched.
   * @param agent - caller whose Session selects the file policy and owns the lease.
   * @param request - optional source directory.
   * @param start - starts the delegate in the directory it must use and returns its activation.
   * @param onKept - receives each checkout this call or a previous crashed run of this Session left behind; failures are logged.
   * @param signal - cancellation of provisioning only; settlement always runs to completion.
   * @returns the activation, where it runs, and a promise for the settlement.
   */
  async isolate<T extends IsolatedActivation>(
    agent: Agent,
    request: IsolateRequest,
    start: (cwd: string) => Promise<T>,
    onKept: (report: KeptReport) => void,
    signal?: AbortSignal,
  ): Promise<Isolated<T>> {
    const operationSignal = this.operation(signal)
    const git = await this.context(agent, operationSignal, request.cwd)
    const source = await this.repository(git)
    if ('reason' in source) {
      const activation = await start(git.cwd)
      return { activation, isolation: { kind: 'degraded', cwd: git.cwd, reason: source.reason }, settled: Promise.resolve(undefined) }
    }
    const { root } = source
    const session = String(agent.session.id)
    await this.reapForSession(git, root, session, onKept)
    const base = await this.resolveBase(git, root, source.head)
    const branch = `${LEASE_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const owner = await currentOwner()
    const file: LeaseFile = {
      v: 1, state: 'provisioning', branch, ownerSession: session, ownerHost: HOST, ownerPid: owner.pid, ownerStart: owner.start,
      baseCommit: base.commit, baseLabel: base.label, createdAtMs: Date.now(),
    }
    let added: string | undefined
    const created = await this.exclusive(async () => {
      try {
        const checkout = await this.checkout(git, { branch, revision: base.commit }, async (path) => {
          added = path
          await this.writeLease(git, root, path, file)
        })
        await this.writeLease(git, root, checkout.path, { ...file, state: 'held' })
        return checkout
      } catch (error) {
        if (added !== undefined) await this.abandon(git, root, added, branch)
        throw error
      }
    })
    const offset = relative(root, git.cwd)
    const cwd = offset.length === 0 || offset.startsWith('..') ? created.path : join(created.path, offset)
    let activation: T
    try {
      activation = await start(cwd)
    } catch (error) {
      await this.abandon(git, root, created.path, branch)
      throw error
    }
    const settled = activation.result.then(() => undefined, () => undefined)
      .then(() => this.finish(git.policy, root, created.path, branch, onKept))
    return {
      activation,
      isolation: { kind: 'worktree', path: created.path, cwd, branch, baseCommit: base.commit, baseLabel: base.label },
      settled,
    }
  }

  /**
   * Settle every lease in the caller's repository whose owning process has died.
   * Clean checkouts are removed; checkouts with changes become kept and stay for a human.
   * Safe to repeat and to run concurrently with other processes.
   * @param agent - caller whose current directory selects the repository and file policy.
   * @param signal - cancellation of the sweep.
   * @returns the leases settled by this call; empty outside a Git work tree.
   */
  async reap(agent: Agent, signal?: AbortSignal): Promise<Settlement[]> {
    const operationSignal = this.operation(signal)
    const git = await this.context(agent, operationSignal)
    const source = await this.repository(git)
    if ('reason' in source) return []
    return (await this.sweep(git, source.root)).map(entry => entry.settlement)
  }

  /**
   * List delegate leases in the caller's repository without changing anything.
   * @param agent - caller whose current directory selects the repository and file policy.
   * @param signal - cancellation of the listing.
   * @returns one summary per lease worktree or orphaned lease branch; empty outside a Git work tree.
   */
  async list(agent: Agent, signal?: AbortSignal): Promise<LeaseSummary[]> {
    const operationSignal = this.operation(signal)
    const git = await this.context(agent, operationSignal)
    const source = await this.repository(git)
    if ('reason' in source) return []
    const found = await this.inspectLeases(git, source.root)
    return [
      ...found.leases.map(lease => ({
        path: lease.path, branch: lease.branch, status: lease.status,
        ownerSession: lease.file?.ownerSession, baseCommit: lease.file?.baseCommit,
      })),
      ...found.orphans.map(({ branch }) => ({ path: '', branch, status: 'unowned' as const, ownerSession: undefined, baseCommit: undefined })),
    ]
  }

  private operation(signal?: AbortSignal): AbortSignal {
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    combined.throwIfAborted()
    return combined
  }

  private bind(policy: SandboxExecutionPolicy, cwd: string, signal: AbortSignal): GitContext {
    const exec = (directory: string, argv: [string, ...string[]], allowedExitCodes?: number[], env?: NodeJS.ProcessEnv) => runCommand(
      this.ctx, this.config, policy, directory, argv, signal, allowedExitCodes, env,
    )
    return {
      policy, cwd, signal,
      git: (directory, args, allowedExitCodes, env) => exec(
        directory, [this.config.gitCommand, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], allowedExitCodes, env,
      ),
      node: (directory, script, ...args) => exec(directory, [this.config.nodeCommand, '--input-type=module', '-e', script, ...args]),
    }
  }

  private async context(agent: Agent, signal: AbortSignal, requestedCwd?: string): Promise<GitContext> {
    const current = await this.ctx.workingDirectory.ensure(agent, signal)
    const cwd = requestedCwd === undefined
      ? current
      : this.ctx.fs.processPath(await this.ctx.fs.resolve(requestedCwd, { cwd: current, signal }))
    return this.bind(this.ctx.sandboxPolicy.resolve({ session: agent.session }), cwd, signal)
  }

  private async createCheckout(agent: Agent, spec: WorktreeSpec, signal: AbortSignal): Promise<CreatedWorktree> {
    const created = await this.checkout(await this.context(agent, signal), spec)
    try {
      const path = await this.ctx.workingDirectory.set(agent, created.path, signal)
      return { ...created, path }
    } catch (error) {
      throw incomplete(created.branch, created.path, error)
    }
  }

  /**
   * Create the branch and checkout for a spec. The caller's working directory is never changed.
   * @param onAdded - runs once Git has registered the worktree and before its files are written.
   */
  private async checkout(
    git: GitContext,
    { branch, revision }: WorktreeSpec,
    onAdded?: (path: string) => Promise<void>,
  ): Promise<CreatedWorktree> {
    const { cwd, signal } = git
    const run = git.git
    await run(cwd, ['check-ref-format', `refs/heads/${branch}`])
    const rootOutput = await run(cwd, ['rev-parse', '--show-toplevel'])
    const rootTarget = await this.ctx.fs.resolve(rootOutput.stdout.replace(/\r?\n$/, ''), { cwd, signal })
    const repositoryRoot = this.ctx.fs.processPath(rootTarget)
    const base = await run(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])
    const baseCommit = base.stdout.trim()
    const existing = await run(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
    if (existing.exitCode === 0) throw new Error(`worktree branch already exists: ${branch}`)
    const pool = await this.ctx.fs.resolve(this.config.directory, { cwd: repositoryRoot, signal })
    const poolPath = this.ctx.fs.processPath(pool)
    const destination = await this.ctx.fs.resolve(branch, { cwd: poolPath, signal })
    const path = this.ctx.fs.processPath(destination)
    if (await this.ctx.fs.lstat(path, undefined, signal) !== undefined) throw new Error(`worktree path already exists: ${path}`)
    try {
      await git.node(repositoryRoot, PREPARE_DIRECTORY, poolPath, path)
      await run(repositoryRoot, ['--work-tree', repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', branch, '--', path, baseCommit])
      await onAdded?.(path)
      await run(path, ['--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', baseCommit], undefined, await this.filterOverrides((args, allowed) => run(path, args, allowed)))
      return { path: this.ctx.fs.processPath(await this.ctx.fs.resolve(path, { signal })), branch, baseCommit, repositoryRoot }
    } catch (error) {
      throw incomplete(branch, path, error)
    }
  }

  /** Environment overrides that disable every configured clean, smudge, process, and required filter driver. */
  private async filterOverrides(configure: ConfigReader): Promise<NodeJS.ProcessEnv> {
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

  private leaseFilterOverrides(git: GitContext, lease: LeaseRef): Promise<NodeJS.ProcessEnv> {
    return this.filterOverrides((args, allowed) => this.inLease(git, lease, args, allowed))
  }

  /** Serialize provisioning and sweeps so a sweep never sees a branch whose worktree Git has not registered yet. */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.exclusion.then(action, action)
    this.exclusion = result.then(() => undefined, () => undefined)
    return result
  }

  private async repository(git: GitContext): Promise<{ root: string; head: string } | { reason: string }> {
    const top = await git.git(git.cwd, ['rev-parse', '--show-toplevel'], [0, 128])
    if (top.exitCode !== 0) {
      if (/not a git repository|must be run in a work tree/i.test(top.stderr)) return { reason: `${git.cwd} is not inside a Git work tree` }
      throw new Error(`worktree command failed (128): ${top.stderr.trim()}`)
    }
    const target = await this.ctx.fs.resolve(top.stdout.replace(/\r?\n$/, ''), { cwd: git.cwd, signal: git.signal })
    const root = this.ctx.fs.processPath(target)
    const head = await git.git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], [0, 1])
    if (head.exitCode !== 0) return { reason: `${root} has no commits` }
    return { root, head: head.stdout.trim() }
  }

  private async resolveBase(git: GitContext, root: string, head: string): Promise<{ commit: string; label: string }> {
    if (this.config.baseRef === 'head') return { commit: head, label: 'HEAD' }
    const symbolic = await git.git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], [0, 1])
    const remote = symbolic.stdout.trim()
    if (remote.length > 0) {
      const commit = await git.git(root, ['rev-parse', '--verify', '-q', '--end-of-options', `${remote}^{commit}`], [0, 1])
      if (commit.exitCode === 0) return { commit: commit.stdout.trim(), label: remote.replace(/^refs\/remotes\//, '') }
    }
    return { commit: head, label: 'HEAD (no origin/HEAD)' }
  }

  private async writeLease(git: GitContext, root: string, path: string, file: LeaseFile): Promise<void> {
    const adminDir = await this.adminDirectory(git, root, path)
    await git.node(root, WRITE_FILE, join(adminDir, LEASE_FILE), JSON.stringify(file))
  }

  /**
   * Find the admin directory Git registered for a checkout. Only the repository's own `worktrees/<id>/gitdir`
   * records are trusted, never the `.git` pointer inside the checkout, which the delegate can rewrite.
   */
  private async adminDirectory(git: GitContext, root: string, path: string): Promise<string> {
    const common = (await git.git(root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    const registry = join(this.ctx.fs.processPath(await this.ctx.fs.resolve(common, { cwd: root, signal: git.signal })), 'worktrees')
    const target = await this.ctx.fs.resolve(path, { signal: git.signal })
    for (const entry of await this.ctx.fs.listDir(await this.ctx.fs.resolve(registry, { signal: git.signal }), git.signal)) {
      const adminDir = join(registry, entry.name)
      const record = await this.ctx.fs.lstat(join(adminDir, 'gitdir'), undefined, git.signal)
      if (record === undefined) continue
      const text = await this.ctx.fs.readText(await this.ctx.fs.resolve(join(adminDir, 'gitdir'), { signal: git.signal }), git.signal)
      const linked = await this.ctx.fs.resolve(dirname(text.trim()), { cwd: adminDir, signal: git.signal })
      if (this.ctx.fs.processPath(linked) === this.ctx.fs.processPath(target)) return adminDir
    }
    throw new Error(`no registered worktree administration directory for ${path}`)
  }

  private async readLease(
    git: GitContext,
    root: string,
    path: string,
    branch: string,
  ): Promise<{ adminDir: string; file: LeaseFile | undefined }> {
    const adminDir = await this.adminDirectory(git, root, path)
    const location = join(adminDir, LEASE_FILE)
    if (await this.ctx.fs.lstat(location, undefined, git.signal) === undefined) return { adminDir, file: undefined }
    const parsed = parseLeaseFile(await this.ctx.fs.readText(await this.ctx.fs.resolve(location, { signal: git.signal }), git.signal))
    return { adminDir, file: parsed?.branch === branch ? parsed : undefined }
  }

  private async inspectLeases(git: GitContext, root: string): Promise<{
    leases: Array<{ path: string; branch: string; status: LeaseStatus; file: LeaseFile | undefined; adminDir: string | undefined }>
    orphans: Array<{ branch: string; tip: string }>
  }> {
    const listing = await git.git(root, ['worktree', 'list', '--porcelain', '-z'])
    const leases = []
    const attached = new Set<string>()
    for (const entry of parseWorktreeList(listing.stdout)) {
      if (entry.branch === undefined || !isLeaseBranch(entry.branch)) continue
      attached.add(entry.branch)
      if (await this.ctx.fs.lstat(entry.path, undefined, git.signal) === undefined) {
        leases.push({ path: entry.path, branch: entry.branch, status: 'missing' as const, file: undefined, adminDir: undefined })
        continue
      }
      const { adminDir, file } = await this.readLease(git, root, entry.path, entry.branch).catch(
        () => ({ adminDir: undefined, file: undefined }),
      )
      const alive = file !== undefined && file.state !== 'kept' && file.ownerHost === HOST
        && await ownerAlive(file.ownerPid, file.ownerStart)
      leases.push({ path: entry.path, branch: entry.branch, status: classify(file, HOST, alive), file, adminDir })
    }
    const refs = await git.git(root, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${LEASE_PREFIX}`])
    const orphans = refs.stdout.split('\n')
      .filter(line => line.length > 0)
      .map((line) => {
        const [ref = '', tip = ''] = line.split(' ')
        return { branch: ref.replace(/^refs\/heads\//, ''), tip }
      })
      .filter(({ branch }) => !attached.has(branch))
    return { leases, orphans }
  }

  /** Run Git against a lease checkout through its registered admin directory, not the checkout's own `.git` pointer. */
  private inLease(
    git: GitContext,
    lease: LeaseRef,
    args: string[],
    allowedExitCodes?: number[],
    env?: NodeJS.ProcessEnv,
  ): Promise<CommandResult> {
    return git.git(lease.path, ['--git-dir', lease.adminDir, '--work-tree', lease.path, ...args], allowedExitCodes, env)
  }

  private async inspect(git: GitContext, lease: LeaseRef, env: NodeJS.ProcessEnv): Promise<Inspection> {
    const { branch } = lease
    const run = (args: string[], allowed?: number[], extra?: NodeJS.ProcessEnv) => this.inLease(git, lease, args, allowed, extra)
    const status = await run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], undefined, env)
    const stash = await run(['reflog', 'show', '--format=%gs', 'refs/stash'], [0, 128])
    const head = await run(['rev-parse', '--verify', '-q', 'HEAD'], [0, 1])
    const symbolic = await run(['symbolic-ref', '-q', 'HEAD'], [0, 1])
    const tip = await run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], [0, 1])
    return {
      ...parseStatus(status.stdout),
      stashed: stashedFrom(stash.stdout, branch),
      head: head.stdout.trim(),
      symbolicRef: symbolic.exitCode === 0 ? symbolic.stdout.trim() : undefined,
      branchTip: tip.exitCode === 0 ? tip.stdout.trim() : undefined,
    }
  }

  /**
   * Remove a clean lease or keep a changed one. Removal never forces: Git itself refuses when files
   * appeared after inspection, and that refusal keeps the checkout. The branch is deleted only while it
   * still points at the base commit, so a branch that advanced is never lost. Repeating a settled lease is a no-op.
   */
  private async settle(git: GitContext, root: string, lease: LeaseRef): Promise<Settlement> {
    const { path, branch } = lease
    const baseCommit = lease.file.baseCommit
    const env = await this.leaseFilterOverrides(git, lease)
    const inspection = await this.inspect(git, lease, env)
    const decision = decide(inspection, { branch, baseCommit })
    if (decision.action === 'keep') return this.keep(git, lease, inspection, decision.reason)
    await this.persist(git, lease, 'settling')
    const removal = await git.git(root, ['worktree', 'remove', '--', path], [0, 1, 128], env)
    if (removal.exitCode !== 0 && await this.ctx.fs.lstat(path, undefined, git.signal) !== undefined) {
      const after = await this.inspect(git, lease, env)
      const changed = decide(after, { branch, baseCommit }).action === 'keep'
      return this.keep(git, lease, after, changed ? 'changed-during-removal' : 'removal-refused')
    }
    await this.deleteBranch(git, root, branch, baseCommit)
    return { kind: 'removed', branch }
  }

  private async keep(git: GitContext, lease: LeaseRef, inspection: Inspection, reason: KeptReason): Promise<Settlement> {
    await this.persist(git, lease, 'kept')
    return {
      kind: 'kept', path: lease.path, branch: lease.branch, baseCommit: lease.file.baseCommit,
      headCommit: inspection.head, uncommitted: inspection.dirty || inspection.ignored, reason,
    }
  }

  private async persist(git: GitContext, lease: LeaseRef, state: LeaseFile['state']): Promise<void> {
    await git.node(git.cwd, WRITE_FILE, join(lease.adminDir, LEASE_FILE), JSON.stringify({ ...lease.file, state }))
  }

  /** Compare-and-delete: Git deletes the ref only while it still has the expected value. */
  private async deleteBranch(git: GitContext, root: string, branch: string, expected: string): Promise<void> {
    await git.git(root, ['update-ref', '-d', '--end-of-options', `refs/heads/${branch}`, expected], [0, 1, 128])
  }

  /** Settle a lease this process owns once its delegate stopped. Failures are logged and left for the reaper. */
  private async finish(
    policy: SandboxExecutionPolicy,
    root: string,
    path: string,
    branch: string,
    onKept: (report: KeptReport) => void,
  ): Promise<Settlement | undefined> {
    try {
      const git = this.bind(policy, root, new AbortController().signal)
      const { adminDir, file } = await this.readLease(git, root, path, branch)
      if (file === undefined) throw new Error('lease metadata is missing')
      const settlement = await this.settle(git, root, { path, branch, adminDir, file })
      if (settlement.kind === 'kept') this.deliver(onKept, settlement)
      return settlement
    } catch (error) {
      this.ctx.logger.warn(`worktree lease ${branch} at ${path} was not settled; a later sweep will retry after this process exits: ${String(error)}`)
      return undefined
    }
  }

  private deliver(onKept: (report: KeptReport) => void, settlement: Settlement & { kind: 'kept' }): void {
    const { kind: _kind, ...report } = settlement
    try {
      onKept(report)
    } catch (error) {
      this.ctx.logger.warn(`worktree kept report for ${report.path} was not delivered: ${String(error)}`)
    }
  }

  /** Roll back a lease whose delegate never started; a failure leaves it for the reaper. */
  private async abandon(git: GitContext, root: string, path: string, branch: string): Promise<void> {
    try {
      const own = this.bind(git.policy, root, new AbortController().signal)
      const { adminDir, file } = await this.readLease(own, root, path, branch)
      if (file === undefined) return
      if (file.state === 'provisioning') await this.completeCheckout(own, { path, branch, adminDir, file })
      await this.settle(own, root, { path, branch, adminDir, file })
    } catch (error) {
      this.ctx.logger.warn(`worktree lease ${branch} at ${path} could not be rolled back: ${String(error)}`)
    }
  }

  /** Finish the checkout of a lease that crashed while provisioning. No delegate ever ran in it. */
  private async completeCheckout(git: GitContext, lease: LeaseRef): Promise<void> {
    const env = await this.leaseFilterOverrides(git, lease)
    await this.inLease(git, lease, ['reset', '--hard', '--no-recurse-submodules', lease.file.baseCommit], undefined, env)
  }

  private async sweep(git: GitContext, root: string): Promise<Array<{ settlement: Settlement; ownerSession: string | undefined }>> {
    return this.exclusive(async () => {
      const bound = this.bind(git.policy, root, git.signal)
      const found = await this.inspectLeases(bound, root)
      const settled: Array<{ settlement: Settlement; ownerSession: string | undefined }> = []
      for (const lease of found.leases) {
        const action = reapAction(lease.status, lease.file?.state)
        if (action === 'skip' || lease.file === undefined || lease.adminDir === undefined) continue
        const ref = { path: lease.path, branch: lease.branch, adminDir: lease.adminDir, file: lease.file }
        try {
          if (action === 'replay-provisioning') await this.completeCheckout(bound, ref)
          settled.push({ settlement: await this.settle(bound, root, ref), ownerSession: lease.file.ownerSession })
        } catch (error) {
          this.ctx.logger.warn(`worktree lease ${lease.branch} at ${lease.path} was not settled by the sweep: ${String(error)}`)
        }
      }
      for (const { branch, tip } of found.orphans) {
        if (await this.sweepOrphan(bound, root, branch, tip)) settled.push({ settlement: { kind: 'removed', branch }, ownerSession: undefined })
      }
      return settled
    })
  }

  /** Delete a lease branch without a worktree only if its reflog proves it never left its creation commit. */
  private async sweepOrphan(git: GitContext, root: string, branch: string, tip: string): Promise<boolean> {
    const log = await git.git(root, ['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`], [0, 128])
    const oldest = log.stdout.split('\n').filter(line => line.length > 0).at(-1)
    const [commit, ...subject] = oldest?.split(' ') ?? []
    const created = subject.join(' ').startsWith('branch: Created from') ? commit : undefined
    if (decideOrphan(tip, created) === 'keep') return false
    await this.deleteBranch(git, root, branch, tip)
    return true
  }

  private async reapForSession(git: GitContext, root: string, session: string, onKept: (report: KeptReport) => void): Promise<void> {
    try {
      for (const { settlement, ownerSession } of await this.sweep(git, root)) {
        if (settlement.kind === 'kept' && ownerSession === session) this.deliver(onKept, settlement)
      }
    } catch (error) {
      this.ctx.logger.warn(`worktree sweep failed; provisioning continues: ${String(error)}`)
    }
  }
}

function incomplete(branch: string, path: string, error: unknown): Error {
  return new Error(`Could not finish worktree ${branch} at ${path}. Any created checkout and branch are retained. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}

export default WorktreeService
