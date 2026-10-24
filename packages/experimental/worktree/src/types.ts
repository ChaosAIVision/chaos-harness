/** Public requests and results for creating a Git worktree and entering it. */

/** A new checkout from a locally available Git commit, branch, or tag. */
export interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
}

/** Committed Git baseline and the calling Session's resulting working directory. */
export interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}

/** Why a delegate checkout was kept instead of removed. */
export type KeptReason = 'changed' | 'changed-during-removal' | 'removal-refused'

/** A checkout left on disk for a human to inspect, merge, or delete. */
export interface KeptReport {
  /** Absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Lease branch, still present. */
  branch: string
  /** Commit the checkout was created from. */
  baseCommit: string
  /** Commit the checkout's HEAD pointed at when it was settled. */
  headCommit: string
  /** Whether tracked changes, untracked files, or ignored files other than `node_modules` were present. */
  uncommitted: boolean
  /** The observation that prevented removal. */
  reason: KeptReason
}

/** Outcome of settling one lease. */
export type Settlement = { kind: 'removed'; branch: string } | ({ kind: 'kept' } & KeptReport)

/** Where an isolated child runs. */
export type Isolation =
  | {
    kind: 'worktree'
    /** Lease checkout root. */
    path: string
    /** Directory the child starts in: the lease path plus the caller's offset inside its repository. */
    cwd: string
    branch: string
    baseCommit: string
    /** Human-readable origin of the base, such as `origin/main` or `HEAD (no origin/HEAD)`. */
    baseLabel: string
  }
  | {
    kind: 'degraded'
    /** The caller's directory, unchanged. */
    cwd: string
    reason: string
  }

/** Lease liveness as seen from this host. */
export type LeaseStatus = 'live' | 'dead' | 'foreign' | 'kept' | 'unowned' | 'missing'

/** One lease worktree as listed to humans and the reaper. */
export interface LeaseSummary {
  path: string
  branch: string
  status: LeaseStatus
  /** Owning Session id; absent when the metadata file is missing. */
  ownerSession: string | undefined
  baseCommit: string | undefined
}

/** A child execution whose end triggers settlement. */
export interface IsolatedActivation {
  /** Settles when the child has stopped writing. Rejection also settles the lease. */
  readonly result: Promise<unknown>
}
