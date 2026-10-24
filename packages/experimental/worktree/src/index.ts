/** Creates Git worktrees: retained and entered on request, or leased to a delegate and settled when it stops. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { checkout, incomplete } from './checkout.ts'
import type { WorktreeSpec } from './checkout.ts'
import { bindGit, repository } from './git-context.ts'
import type { GitContext, Repository, ResolvedConfig, Runtime } from './git-context.ts'
import { isReservedName, LEASE_PREFIX } from './lease.ts'
import { Leases } from './leases.ts'
import type {
  CreatedWorktree, CreateWorktreeRequest, IsolatedActivation, Isolated, KeptReport, LeaseSummary, Settlement,
} from './types.ts'

export type {
  CreatedWorktree, CreateWorktreeRequest, IsolatedActivation, Isolated, Isolation, KeptReason, KeptReport, LeaseStatus, LeaseSummary,
  Settlement,
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

/** Per-call options of {@link WorktreeService.isolate}. */
export interface IsolateRequest {
  /** Source repository directory; relative paths resolve against the agent's current directory. Omission uses that directory. */
  cwd?: string
}

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
  private readonly runtime: Runtime
  private readonly leases: Leases
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

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
    this.runtime = { ctx, config: this.config }
    this.leases = new Leases(this.runtime)
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
   * edits, ignored files other than `node_modules`, commits, a stash entry, or a moved HEAD is kept and
   * reported through `onKept`. Outside a Git work tree, or in a repository without commits, the delegate
   * runs in the caller's directory and `isolation` says why. Leases whose owning process died are settled
   * first. A lease owned by a live process, or by another host, is never touched.
   * @param agent - caller whose Session selects the file policy and owns the lease.
   * @param request - optional source directory.
   * @param start - starts the delegate in the directory it must use and returns its activation.
   * @param onKept - receives each checkout this call or a previous crashed run of this Session left behind; failures are logged.
   * @param signal - cancellation of provisioning only; settlement always runs to completion.
   * @returns the activation, where it runs, and a promise for the settlement. Service disposal aborts provisioning
   * and waits for admitted activations to stop and settle; the activation owner remains responsible for stopping them.
   */
  async isolate<T extends IsolatedActivation>(
    agent: Agent,
    request: IsolateRequest,
    start: (cwd: string) => Promise<T>,
    onKept: (report: KeptReport) => void,
    signal?: AbortSignal,
  ): Promise<Isolated<T>> {
    const operation = this.withRepository<Isolated<T>>(
      agent, signal, request.cwd,
      (git, source) => this.leases.isolate(git, source, String(agent.session.id), start, onKept),
      async (git, reason) => ({
        activation: await start(git.cwd), isolation: { kind: 'degraded', cwd: git.cwd, reason }, settled: Promise.resolve(undefined),
      }),
    )
    const completion = operation.then(isolated => isolated.settled)
    this.pending.add(completion)
    void completion.then(
      () => { this.pending.delete(completion) },
      () => { this.pending.delete(completion) },
    )
    return operation
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
    return this.withRepository(agent, signal, undefined, (git, { root }) => this.leases.reap(git, root), () => [])
  }

  /**
   * List delegate leases in the caller's repository without changing anything.
   * @param agent - caller whose current directory selects the repository and file policy.
   * @param signal - cancellation of the listing.
   * @returns one summary per lease worktree or orphaned lease branch; empty outside a Git work tree.
   */
  async list(agent: Agent, signal?: AbortSignal): Promise<LeaseSummary[]> {
    return this.withRepository(agent, signal, undefined, (git, { root }) => this.leases.list(git, root), () => [])
  }

  private operation(signal?: AbortSignal): AbortSignal {
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    combined.throwIfAborted()
    return combined
  }

  /**
   * Bind the caller's policy and directory, locate its repository, and run `inRepository`; `outside` runs
   * instead when the directory is not a Git work tree with commits.
   */
  private async withRepository<T>(
    agent: Agent,
    signal: AbortSignal | undefined,
    requestedCwd: string | undefined,
    inRepository: (git: GitContext, source: Repository) => Promise<T>,
    outside: (git: GitContext, reason: string) => T | Promise<T>,
  ): Promise<T> {
    const git = await this.context(agent, this.operation(signal), requestedCwd)
    const source = await repository(this.runtime, git)
    return 'reason' in source ? outside(git, source.reason) : inRepository(git, source)
  }

  private async context(agent: Agent, signal: AbortSignal, requestedCwd?: string): Promise<GitContext> {
    const current = await this.ctx.workingDirectory.ensure(agent, signal)
    const cwd = requestedCwd === undefined
      ? current
      : this.ctx.fs.processPath(await this.ctx.fs.resolve(requestedCwd, { cwd: current, signal }))
    return bindGit(this.runtime, this.ctx.sandboxPolicy.resolve({ session: agent.session }), cwd, signal)
  }

  private async createCheckout(agent: Agent, spec: WorktreeSpec, signal: AbortSignal): Promise<CreatedWorktree> {
    const created = await checkout(this.runtime, await this.context(agent, signal), spec)
    try {
      const path = await this.ctx.workingDirectory.set(agent, created.path, signal)
      return { ...created, path }
    } catch (error) {
      throw incomplete(created.branch, created.path, error)
    }
  }
}

export default WorktreeService
