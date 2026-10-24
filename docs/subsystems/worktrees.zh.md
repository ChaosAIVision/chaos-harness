# Git 工作树

[English](worktrees.md) | 中文

实验性的 [`dsh-experimental-worktree`](../../packages/experimental/worktree/README.zh.md) 服务提供 `ctx.worktrees`。其消费方 [`create_worktree`](../../packages/experimental/tool-worktree/README.zh.md) 创建新的 Git 分支与检出目录，再通过[工作目录服务](working-directory.zh.md)选中它。[Git 工作树可选 bundle](../../packages/experimental/tool-worktree/README.zh.md#use-this-package)通过 GUI 插件管理器一起加载这两个包。它随安装提供，但默认关闭；显式组合也可以挂载这两个包。

## 创建与保留

调用方 Session 的当前目录决定源仓库。创建操作在分配检出目录前，将请求的本地提交、分支或标签固定为具体提交；省略时选择 `HEAD`。每个名称必须对应新分支与未使用的检出路径。操作既不获取缺失对象，也不复制源检出目录中的暂存、未暂存、未跟踪或被忽略文件。

默认目标为 `<current checkout root>/.agents/worktrees/<name>`。`repositoryRoot` 是调用方当前检出目录的顶层目录；因此，链接检出目录会在自身内部保存工作树父目录。仅当服务的分配操作创建了配置指定的父目录时，服务才会写入内容为 `*` 加换行符的 `.gitignore`。已有文件与忽略规则保持不变。调用方 Session 的现有沙箱策略必须允许写入目标目录与共享 Git 管理目录。Git 初始化成功后才改变工作目录。

通过 `working_directory({ cd: path })` 离开时，会保留检出目录与分支。取消或失败也可能留下部分产物；错误会指出它们的位置。服务销毁时会中止待完成操作并等待它们结束。[包 README](../../packages/experimental/worktree/README.zh.md)拥有配置与 Git 要求。

## 请求与结果

请求只选择新名称与本地版本。结果标识创建的检出目录与确切提交；它不会改变 Session 的原始项目或写权限。

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

## 委派租约

`IsolateRequest` 可选择源目录。`isolate()` 保持父级目录不变，并在租约中相同的仓库相对位置启动委派任务。`Isolation` 区分 worktree 与在调用方目录中运行的降级执行。`IsolatedActivation.result` 表示子任务已停止写入。`Isolated.settled` 在清理和保留报告送达后完成，清算失败时值为 `undefined`。

`Settlement` 区分已移除的租约与由 `KeptReport` 描述的保留检出目录。`KeptReason` 标识已观察到的修改、移除期间出现的修改或被拒绝的移除。`LeaseSummary` 在不修改检出目录的情况下提供所有权与 `LeaseStatus`。包 README 定义[租约保留与恢复规则](../../packages/experimental/worktree/README.zh.md)。

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * @returns the activation, where it runs, and a promise for the settlement. Service disposal aborts provisioning
 * and waits for admitted activations to stop and settle; the activation owner remains responsible for stopping them.
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

Types: [Agent](core.zh.md)

Source: [`packages/experimental/worktree/src/index.ts`](../../packages/experimental/worktree/src/index.ts)
<!-- END GENERATED cordis-surface -->
