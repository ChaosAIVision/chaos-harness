/** Delegate lease lifecycle: provision, settle, keep, and sweep checkouts on `dsh/lease/` branches. */

import { randomUUID } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { checkout, filterOverrides } from './checkout.ts'
import { WRITE_FILE } from './directory.ts'
import { bindGit } from './git-context.ts'
import type { CommandResult, GitContext, Repository, Runtime } from './git-context.ts'
import {
  classify, decide, decideOrphan, isLeaseBranch, LEASE_PREFIX, parseLeaseFile, parseStatus, parseWorktreeList, reapAction, stashedFrom,
} from './lease.ts'
import type { Inspection, LeaseFile } from './lease.ts'
import { currentOwner, HOST, ownerAlive } from './owner.ts'
import type { IsolatedActivation, Isolated, KeptReason, KeptReport, LeaseStatus, LeaseSummary, Settlement } from './types.ts'

const LEASE_FILE = 'dsh-lease.json'

/** A lease checkout together with its parsed metadata and admin directory. */
interface LeaseRef {
  path: string
  branch: string
  adminDir: string
  file: LeaseFile
}

interface FoundLease {
  path: string
  branch: string
  status: LeaseStatus
  file: LeaseFile | undefined
  adminDir: string | undefined
}

interface Sweeping {
  settlement: Settlement
  ownerSession: string | undefined
}

/**
 * Owns every lease transition. Git is the registry of checkouts; each lease adds one metadata file in its
 * administration directory. Provisioning and sweeps run one at a time inside one instance, which protects
 * nothing across processes: two processes can sweep together, and settlement stays correct only because every
 * step is idempotent and refuses rather than forces.
 */
export class Leases {
  private exclusion: Promise<void> = Promise.resolve()

  constructor(private readonly runtime: Runtime) {}

  /**
   * Start a delegate in a fresh lease and arrange its settlement.
   * @param git - caller's directory, cancellation, and execution policy.
   * @param repository - canonical source root and its resolved HEAD commit.
   * @param session - owning Session id, also used to deliver reports from earlier crashed leases.
   * @param start - starts the delegate in its lease directory.
   * @param onKept - receives retained checkouts; callback failures are logged.
   * @returns the activation, isolated directory, and settlement promise.
   */
  async isolate<T extends IsolatedActivation>(
    git: GitContext,
    repository: Repository,
    session: string,
    start: (cwd: string) => Promise<T>,
    onKept: (report: KeptReport) => void,
  ): Promise<Isolated<T>> {
    const { root, head } = repository
    await this.reapForSession(git, root, session, onKept)
    const base = await this.resolveBase(git, root, head)
    const branch = `${LEASE_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const owner = await currentOwner()
    const file: LeaseFile = {
      v: 1, state: 'provisioning', branch, ownerSession: session, ownerHost: HOST, ownerPid: owner.pid, ownerStart: owner.start,
      baseCommit: base.commit, baseLabel: base.label, createdAtMs: Date.now(),
    }
    let added: string | undefined
    const created = await this.exclusive(async () => {
      try {
        const made = await checkout(this.runtime, git, { branch, revision: base.commit }, async (path) => {
          added = path
          await this.writeLease(git, root, path, file)
        })
        await this.writeLease(git, root, made.path, { ...file, state: 'held' })
        return made
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
   * Settle every lease whose owner died.
   * @param git - caller's cancellation and execution policy.
   * @param root - canonical repository root to inspect.
   * @returns settlements completed by this sweep.
   */
  async reap(git: GitContext, root: string): Promise<Settlement[]> {
    return (await this.sweep(git, root)).map(entry => entry.settlement)
  }

  /**
   * List leases and orphaned lease branches without changing them.
   * @param git - caller's cancellation and execution policy.
   * @param root - canonical repository root to inspect.
   * @returns checkout ownership and liveness summaries, including branches without a checkout.
   */
  async list(git: GitContext, root: string): Promise<LeaseSummary[]> {
    const found = await this.inspectLeases(git, root)
    return [
      ...found.leases.map(lease => ({
        path: lease.path, branch: lease.branch, status: lease.status,
        ownerSession: lease.file?.ownerSession, baseCommit: lease.file?.baseCommit,
      })),
      ...found.orphans.map(({ branch }) => ({ branch, status: 'unowned' as const, ownerSession: undefined, baseCommit: undefined })),
    ]
  }

  private async resolveBase(git: GitContext, root: string, head: string): Promise<{ commit: string; label: string }> {
    if (this.runtime.config.baseRef === 'head') return { commit: head, label: 'HEAD' }
    const symbolic = await git.git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], [0, 1])
    const remote = symbolic.stdout.trim()
    if (remote.length > 0) {
      const commit = await git.git(root, ['rev-parse', '--verify', '-q', '--end-of-options', `${remote}^{commit}`], [0, 1])
      if (commit.exitCode === 0) return { commit: commit.stdout.trim(), label: remote.replace(/^refs\/remotes\//, '') }
    }
    return { commit: head, label: 'HEAD (no origin/HEAD)' }
  }

  /** Serialize provisioning and sweeps so a sweep never sees a branch whose worktree Git has not registered yet. */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.exclusion.then(action, action)
    this.exclusion = result.then(() => undefined, () => undefined)
    return result
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
    const { fs } = this.runtime.ctx
    const common = (await git.git(root, ['rev-parse', '--git-common-dir'])).stdout.trim()
    const registry = join(fs.processPath(await fs.resolve(common, { cwd: root, signal: git.signal })), 'worktrees')
    const target = fs.processPath(await fs.resolve(path, { signal: git.signal }))
    for (const entry of await fs.listDir(await fs.resolve(registry, { signal: git.signal }), git.signal)) {
      const adminDir = join(registry, entry.name)
      const record = join(adminDir, 'gitdir')
      if (await fs.lstat(record, undefined, git.signal) === undefined) continue
      const text = await fs.readText(await fs.resolve(record, { signal: git.signal }), git.signal)
      const linked = fs.processPath(await fs.resolve(dirname(text.trim()), { cwd: adminDir, signal: git.signal }))
      if (linked === target) return adminDir
    }
    throw new Error(`no registered worktree administration directory for ${path}`)
  }

  private async readLease(
    git: GitContext,
    root: string,
    path: string,
    branch: string,
  ): Promise<{ adminDir: string; file: LeaseFile | undefined }> {
    const { fs } = this.runtime.ctx
    const adminDir = await this.adminDirectory(git, root, path)
    const location = join(adminDir, LEASE_FILE)
    if (await fs.lstat(location, undefined, git.signal) === undefined) return { adminDir, file: undefined }
    const parsed = parseLeaseFile(await fs.readText(await fs.resolve(location, { signal: git.signal }), git.signal))
    return { adminDir, file: parsed?.branch === branch ? parsed : undefined }
  }

  private async inspectLeases(git: GitContext, root: string): Promise<{
    leases: FoundLease[]
    orphans: Array<{ branch: string; tip: string }>
  }> {
    const { fs } = this.runtime.ctx
    const listing = await git.git(root, ['worktree', 'list', '--porcelain', '-z'])
    const leases: FoundLease[] = []
    const attached = new Set<string>()
    for (const entry of parseWorktreeList(listing.stdout)) {
      if (entry.branch === undefined || !isLeaseBranch(entry.branch)) continue
      attached.add(entry.branch)
      if (await fs.lstat(entry.path, undefined, git.signal) === undefined) {
        leases.push({ path: entry.path, branch: entry.branch, status: 'missing', file: undefined, adminDir: undefined })
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

  private leaseFilterOverrides(git: GitContext, lease: LeaseRef): Promise<NodeJS.ProcessEnv> {
    return filterOverrides((args, allowed) => this.inLease(git, lease, args, allowed))
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
    if (removal.exitCode !== 0 && await this.runtime.ctx.fs.lstat(path, undefined, git.signal) !== undefined) {
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
      const git = bindGit(this.runtime, policy, root, new AbortController().signal)
      const { adminDir, file } = await this.readLease(git, root, path, branch)
      if (file === undefined) throw new Error('lease metadata is missing')
      const settlement = await this.settle(git, root, { path, branch, adminDir, file })
      if (settlement.kind === 'kept') this.deliver(onKept, settlement)
      return settlement
    } catch (error) {
      this.runtime.ctx.logger.warn(`worktree lease ${branch} at ${path} was not settled; a later sweep will retry after this process exits: ${String(error)}`)
      return undefined
    }
  }

  private deliver(onKept: (report: KeptReport) => void, settlement: Settlement & { kind: 'kept' }): void {
    const { kind: _kind, ...report } = settlement
    try {
      onKept(report)
    } catch (error) {
      this.runtime.ctx.logger.warn(`worktree kept report for ${report.path} was not delivered: ${String(error)}`)
    }
  }

  /** Roll back a lease whose delegate never started; a failure leaves it for the reaper. */
  private async abandon(git: GitContext, root: string, path: string, branch: string): Promise<void> {
    try {
      const own = bindGit(this.runtime, git.policy, root, new AbortController().signal)
      const { adminDir, file } = await this.readLease(own, root, path, branch)
      if (file === undefined) return
      if (file.state === 'provisioning') await this.completeCheckout(own, { path, branch, adminDir, file })
      await this.settle(own, root, { path, branch, adminDir, file })
    } catch (error) {
      this.runtime.ctx.logger.warn(`worktree lease ${branch} at ${path} could not be rolled back: ${String(error)}`)
    }
  }

  /** Finish the checkout of a lease that crashed while provisioning. No delegate ever ran in it. */
  private async completeCheckout(git: GitContext, lease: LeaseRef): Promise<void> {
    const env = await this.leaseFilterOverrides(git, lease)
    await this.inLease(git, lease, ['reset', '--hard', '--no-recurse-submodules', lease.file.baseCommit], undefined, env)
  }

  private async sweep(git: GitContext, root: string): Promise<Sweeping[]> {
    return this.exclusive(async () => {
      const bound = bindGit(this.runtime, git.policy, root, git.signal)
      const found = await this.inspectLeases(bound, root)
      const settled: Sweeping[] = []
      for (const lease of found.leases) {
        const action = reapAction(lease.status, lease.file?.state)
        if (action === 'skip' || lease.file === undefined || lease.adminDir === undefined) continue
        const ref = { path: lease.path, branch: lease.branch, adminDir: lease.adminDir, file: lease.file }
        try {
          if (action === 'replay-provisioning') await this.completeCheckout(bound, ref)
          settled.push({ settlement: await this.settle(bound, root, ref), ownerSession: lease.file.ownerSession })
        } catch (error) {
          this.runtime.ctx.logger.warn(`worktree lease ${lease.branch} at ${lease.path} was not settled by the sweep: ${String(error)}`)
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
      this.runtime.ctx.logger.warn(`worktree sweep failed; provisioning continues: ${String(error)}`)
    }
  }
}
