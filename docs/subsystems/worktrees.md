# Git worktrees

English | [中文](worktrees.zh.md)

The experimental [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.md) service provides `ctx.worktrees`. Its [`create_worktree`](../../packages/experimental/tool-worktree/README.md) consumer creates a new Git branch and checkout, then selects it through the [working-directory service](working-directory.md). The [Git Worktrees optional bundle](../../packages/experimental/tool-worktree/README.md#use-this-package) loads both packages through the GUI plugin manager. It ships switched off; explicit compositions can also mount the two packages.

## Creation and retention

The calling Session's current directory selects the source repository. Creation pins the requested local commit, branch, or tag before allocating the checkout; omission selects `HEAD`. Each name must identify a new branch and an unused checkout path. The operation neither fetches missing objects nor copies staged, unstaged, untracked, or ignored files from the source checkout.

The default destination is `<current checkout root>/.agents/worktrees/<name>`. `repositoryRoot` is the top-level directory of the caller’s current checkout; a linked checkout therefore contains its own pool. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the configured pool directory. Existing files and ignore rules are preserved. The calling Session’s existing sandbox policy must permit writes to the destination and shared Git administration directory. Successful Git setup precedes the working-directory change.

Leaving through `working_directory({ cd: path })` retains the checkout and branch. Cancellation or failure can also retain partial artifacts; the error identifies their location. The service aborts and drains pending operations on disposal. The [package README](../../packages/experimental/worktree/README.md) owns configuration and Git requirements.

## Request and result

The request selects only the new name and local revision. The result identifies the created checkout and exact commit; it does not change the Session's original project or write permissions.

```ts type-equiv
/** A new checkout from a locally available Git commit, branch, or tag. */
interface CreateWorktreeRequest {
  /** New branch name, also used as the relative checkout directory; omission generates a name. */
  name?: string
  /** Local revision to resolve before creation; omission selects HEAD. */
  from?: string
}
```

```ts type-equiv
/** Committed Git baseline and the calling Session's resulting working directory. */
interface CreatedWorktree {
  /** Canonical absolute checkout directory in the filesystem provider's execution world. */
  path: string
  /** Newly created branch name. */
  branch: string
  /** Resolved commit object name; repository-local replacement refs can change its checked-out content. */
  baseCommit: string
  /** Canonical root of the source checkout. */
  repositoryRoot: string
}
```

## Delegate leases

`IsolateRequest` optionally selects a source directory. `isolate()` preserves the parent's directory and starts a delegate at the same repository-relative offset inside its lease. `Isolation` distinguishes a worktree from a degraded execution in the caller's directory. `IsolatedActivation.result` signals that the child stopped writing. `Isolated.settled` resolves after cleanup and kept-report delivery, with `undefined` when settlement fails.

`Settlement` distinguishes a removed lease from a retained checkout described by `KeptReport`. `KeptReason` identifies observed changes, changes during removal, or a refused removal. `LeaseSummary` exposes ownership and `LeaseStatus` without mutating the checkout. The package README owns [lease retention and recovery rules](../../packages/experimental/worktree/README.md).

```ts type-equiv
/** Why a delegate checkout was kept instead of removed. */
type KeptReason = 'changed' | 'changed-during-removal' | 'removal-refused'
```

```ts type-equiv
/** A checkout left on disk for a human to inspect, merge, or delete. */
interface KeptReport {
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
```

```ts type-equiv
/** Outcome of settling one lease. */
type Settlement = { kind: 'removed'; branch: string } | ({ kind: 'kept' } & KeptReport)
```

```ts type-equiv
/** Where an isolated child runs. */
type Isolation =
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
```

```ts type-equiv
/** Result of starting a delegate in a lease. */
interface Isolated<T extends IsolatedActivation> {
  /** The value returned by the caller's start function. */
  activation: T
  isolation: Isolation
  /** Resolves after settlement and kept-report delivery; never rejects. Undefined when settlement failed. */
  settled: Promise<Settlement | undefined>
}
```

```ts type-equiv
/** Lease liveness as seen from this host. */
type LeaseStatus = 'live' | 'dead' | 'foreign' | 'kept' | 'unowned' | 'missing'
```

```ts type-equiv
/** One lease worktree as listed to humans and the reaper. */
interface LeaseSummary {
  /** Checkout directory; absent for a lease branch whose worktree is gone. */
  path?: string
  branch: string
  status: LeaseStatus
  /** Owning Session id; absent when the metadata file is missing. */
  ownerSession: string | undefined
  baseCommit: string | undefined
}
```

```ts type-equiv
/** A child execution whose end triggers settlement. */
interface IsolatedActivation {
  /** Settles when the child has stopped writing. Rejection also settles the lease. */
  readonly result: Promise<unknown>
}
```

```ts type-equiv
/** Per-call options of {@link WorktreeService.isolate}. */
interface IsolateRequest {
  /** Source repository directory; relative paths resolve against the agent's current directory. Omission uses that directory. */
  cwd?: string
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworktrees--worktreeservice"></a>

### `ctx.worktrees` — `WorktreeService`

Creates retained Git worktrees and settled delegate leases under the mounted filesystem and sandbox providers.

```ts cordis-catalog
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
async create(agent: Agent, request: CreateWorktreeRequest = {}, signal?: AbortSignal): Promise<CreatedWorktree>

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
 * @returns the activation, where it runs, and a promise for the settlement.
 */
async isolate<T extends IsolatedActivation>( agent: Agent, request: IsolateRequest, start: (cwd: string) => Promise<T>, onKept: (report: KeptReport) => void, signal?: AbortSignal, ): Promise<Isolated<T>>

/**
 * Settle every lease in the caller's repository whose owning process has died.
 * Clean checkouts are removed; checkouts with changes become kept and stay for a human.
 * Safe to repeat and to run concurrently with other processes.
 * @param agent - caller whose current directory selects the repository and file policy.
 * @param signal - cancellation of the sweep.
 * @returns the leases settled by this call; empty outside a Git work tree.
 */
async reap(agent: Agent, signal?: AbortSignal): Promise<Settlement[]>

/**
 * List delegate leases in the caller's repository without changing anything.
 * @param agent - caller whose current directory selects the repository and file policy.
 * @param signal - cancellation of the listing.
 * @returns one summary per lease worktree or orphaned lease branch; empty outside a Git work tree.
 */
async list(agent: Agent, signal?: AbortSignal): Promise<LeaseSummary[]>
```

Types: [Agent](core.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
