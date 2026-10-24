/** Pure lease rules: ownership classification, settle decisions, and Git output parsing. */

import type { KeptReason, KeptReport, LeaseStatus } from './types.ts'

/** Branch namespace reserved for delegate leases. Only the lease code creates or deletes refs here. */
export const LEASE_PREFIX = 'dsh/lease/'

export type LeaseState = 'provisioning' | 'held' | 'settling' | 'kept'

/** Contents of `<git admin dir>/dsh-lease.json`, which Git deletes together with the worktree. */
export interface LeaseFile {
  v: 1
  state: LeaseState
  branch: string
  ownerSession: string
  ownerHost: string
  ownerPid: number
  /** Owner process start time; null where the platform offers none. */
  ownerStart: string | null
  baseCommit: string
  baseLabel: string
  createdAtMs: number
}

const COMMIT_ID = /^[0-9a-f]{40,64}$/
const LEASE_BRANCH = /^dsh\/lease\/[A-Za-z0-9][A-Za-z0-9_-]*$/

const STATES: readonly LeaseState[] = ['provisioning', 'held', 'settling', 'kept']

function isLeaseState(value: string): value is LeaseState {
  return STATES.some(state => state === value)
}

/**
 * Parse lease metadata read from disk.
 * @param text - file contents.
 * @returns the record, or undefined when the text is not a version 1 lease file with a full object id and a lease-namespace branch.
 */
export function parseLeaseFile(text: string): LeaseFile | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (_syntaxError: unknown) {
    // SyntaxError from truncated or foreign content: reported as absent metadata, so the lease is never reaped.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record: Record<string, unknown> = { ...value }
  const { v, state, branch, ownerSession, ownerHost, ownerPid, ownerStart, baseCommit, baseLabel, createdAtMs } = record
  if (v !== 1 || typeof state !== 'string' || !isLeaseState(state)) return undefined
  if (typeof branch !== 'string' || typeof ownerSession !== 'string' || typeof ownerHost !== 'string') return undefined
  if (typeof baseCommit !== 'string' || typeof baseLabel !== 'string') return undefined
  if (!COMMIT_ID.test(baseCommit) || !LEASE_BRANCH.test(branch)) return undefined
  if (typeof ownerPid !== 'number' || !Number.isSafeInteger(ownerPid)) return undefined
  if (typeof createdAtMs !== 'number' || !Number.isSafeInteger(createdAtMs)) return undefined
  if (ownerStart !== null && typeof ownerStart !== 'string') return undefined
  return { v, state, branch, ownerSession, ownerHost, ownerPid, ownerStart, baseCommit, baseLabel, createdAtMs }
}

/**
 * Judge a lease's owner. Liveness is host plus pid plus process start time, so pid reuse cannot
 * keep a lease alive. A missing file or another host's lease is never judged dead.
 * @param file - parsed metadata, undefined when absent or unreadable.
 * @param host - this machine's host name.
 * @param ownerAlive - whether the recorded pid exists with the recorded start time; read only for same-host leases.
 * @returns the lease status, never `missing`, which the caller derives from the filesystem.
 */
export function classify(file: LeaseFile | undefined, host: string, ownerAlive: boolean): Exclude<LeaseStatus, 'missing'> {
  if (file === undefined) return 'unowned'
  if (file.state === 'kept') return 'kept'
  if (file.ownerHost !== host) return 'foreign'
  return ownerAlive ? 'live' : 'dead'
}

export type ReapAction = 'skip' | 'replay-provisioning' | 'settle'

/**
 * Decide what a sweep does to one lease.
 * @param status - result of {@link classify}.
 * @param state - recorded lifecycle state.
 * @returns settle only for dead owners; a dead provisioning lease first finishes its checkout.
 */
export function reapAction(status: LeaseStatus, state: LeaseState | undefined): ReapAction {
  if (status !== 'dead' || state === undefined) return 'skip'
  return state === 'provisioning' ? 'replay-provisioning' : 'settle'
}

/** Git facts observed in a lease checkout at settle time. */
export interface Inspection {
  /** Tracked modifications or non-ignored untracked files. */
  dirty: boolean
  /** Ignored files other than dependency directories, which Git would delete with the worktree. */
  ignored: boolean
  /** A `git stash` made inside the checkout left an entry in the shared stash ref. */
  stashed: boolean
  head: string
  /** Output of `symbolic-ref -q HEAD`; undefined when detached. */
  symbolicRef: string | undefined
  /** Current value of the lease branch ref; undefined when deleted. */
  branchTip: string | undefined
}

export type SettleDecision = { action: 'remove' } | { action: 'keep'; reason: KeptReason }

/**
 * Classify `git status --porcelain=v1 -z --ignored=matching` output.
 * @param output - NUL-delimited status entries.
 * @returns whether tracked or untracked work exists, and whether any ignored path lies outside `node_modules`.
 */
export function parseStatus(output: string): { dirty: boolean; ignored: boolean } {
  let dirty = false
  let ignored = false
  for (const entry of output.split('\0')) {
    if (entry.length === 0) continue
    if (!entry.startsWith('!! ')) dirty = true
    else if (!entry.slice(3).split('/').includes('node_modules')) ignored = true
  }
  return { dirty, ignored }
}

/**
 * Whether the shared stash reflog holds an entry made from a lease checkout.
 * @param subjects - reflog subjects of `refs/stash`, one per line.
 * @param branch - lease branch the checkout had checked out.
 */
export function stashedFrom(subjects: string, branch: string): boolean {
  return subjects.split('\n').some(line => line.startsWith(`WIP on ${branch}:`) || line.startsWith(`On ${branch}:`))
}

/**
 * A lease is removable only when nothing the child could have produced remains.
 * @param inspection - facts read from the checkout.
 * @param lease - lease branch and base commit.
 * @returns remove when clean at the base on the lease branch, otherwise keep.
 */
export function decide(inspection: Inspection, lease: { branch: string; baseCommit: string }): SettleDecision {
  const unchanged = !inspection.dirty && !inspection.ignored && !inspection.stashed
    && inspection.head === lease.baseCommit
    && inspection.symbolicRef === `refs/heads/${lease.branch}`
    && inspection.branchTip === lease.baseCommit
  return unchanged ? { action: 'remove' } : { action: 'keep', reason: 'changed' }
}

/**
 * Decide the fate of a lease branch whose worktree and metadata are gone.
 * @param tip - current branch tip.
 * @param created - commit the branch was created at, from its oldest reflog entry; undefined when no reflog exists.
 * @returns delete only when the branch provably never advanced.
 */
export function decideOrphan(tip: string, created: string | undefined): 'delete' | 'keep' {
  return created !== undefined && tip === created ? 'delete' : 'keep'
}

/** One entry of `git worktree list --porcelain -z`. */
export interface WorktreeEntry {
  path: string
  branch: string | undefined
}

/**
 * Parse NUL-delimited porcelain worktree output.
 * @param output - stdout of `git worktree list --porcelain -z`.
 * @returns entries in Git's order.
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  for (const field of output.split('\0')) {
    if (field.length === 0) {
      current = undefined
    } else if (field.startsWith('worktree ')) {
      current = { path: field.slice('worktree '.length), branch: undefined }
      entries.push(current)
    } else if (current !== undefined && field.startsWith('branch refs/heads/')) {
      current.branch = field.slice('branch refs/heads/'.length)
    }
  }
  return entries
}

/**
 * Whether a branch name lies in the reserved lease namespace.
 * @param branch - short branch name.
 * @returns true for names Git users and `create` must not use.
 */
export function isLeaseBranch(branch: string): boolean {
  return branch.startsWith(LEASE_PREFIX)
}

/**
 * Whether a requested branch name collides with the lease namespace. `dsh` and `dsh/lease` are reserved too:
 * as branch names they would block every `dsh/lease/<id>` ref by a file-versus-directory conflict.
 * @param name - requested branch name.
 */
export function isReservedName(name: string): boolean {
  return name === 'dsh' || name === 'dsh/lease' || isLeaseBranch(name)
}

/**
 * Render a kept checkout for the parent agent.
 * @param report - the settled checkout.
 * @returns one line with path, branch, abbreviated commits, and the dirty flag.
 */
export function formatKept(report: KeptReport): string {
  return `Worktree kept (${report.reason}): path=${report.path} branch=${report.branch} base=${report.baseCommit.slice(0, 7)} head=${report.headCommit.slice(0, 7)} uncommitted=${report.uncommitted}`
}
