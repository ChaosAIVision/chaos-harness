---
description: "Create and enter a retained Git worktree under the calling Session file policy."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-worktree

English | [中文](README.zh.md)

## Summary

Create an isolated checkout from a local commit and continue the same Session in it. Each operation creates a new named branch and leaves the source checkout intact. The existing sandbox governs all writes. Leaving the checkout retains its files and branch. A second operation runs a delegate in a private checkout and removes that checkout when the delegate left nothing behind.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service alongside `workingDirectory`, `fs`, `subprocess`, `sandbox`, and `sandboxPolicy` providers. Add the tool package when models need the operation.

```yaml
- name: '@deepseek-ai/dsh-experimental-worktree'
- name: '@deepseek-ai/dsh-experimental-tool-worktree'
```

`ctx.worktrees.create(agent, { name?, from? }, signal?)` creates a new branch and checkout, then enters the canonical checkout directory through `ctx.workingDirectory.set`. `from` resolves to a local commit before creation and defaults to `HEAD`; staged, unstaged, untracked, and ignored source files are not copied. `baseCommit` reports the resolved commit object name; repository-local replacement refs still apply to the checked-out content. Checkout disables configured Git clean, smudge, and process filters without changing repository configuration. An existing branch or checkout path is an error. The returned record contains `path`, `branch`, `baseCommit`, and `repositoryRoot`.

`ctx.worktrees.isolate(agent, { cwd? }, start, onKept, signal?)` runs a delegate in a private checkout and never moves the caller's working directory. It reaps dead leases, provisions `<pool>/dsh/lease/<nonce>` on the new branch `dsh/lease/<nonce>`, calls `start(cwd)` with the checkout directory plus the caller's offset inside its repository, and settles when the returned activation's `result` settles or rejects. Settlement removes the checkout with `git worktree remove` without `--force` and deletes the branch only while it still points at the base commit. A checkout with tracked changes, non-ignored untracked files, a commit, a detached or switched HEAD, or a file that appeared during removal is kept, and `onKept` receives its `path`, `branch`, `baseCommit`, `headCommit`, `uncommitted`, and `reason`. Ignored files do not count as changes and are deleted with a clean checkout. Outside a Git work tree, or in a repository without commits, `start` runs in the caller's directory and `isolation.kind` is `degraded` with a reason. The result carries `activation`, `isolation`, and `settled`, which resolves after settlement and never rejects.

The lease base is `baseRef`. The default `remote-default` resolves the local `refs/remotes/origin/HEAD` target without fetching and falls back to `HEAD`, naming the fallback in `isolation.baseLabel`; `head` always uses `HEAD`. `ctx.worktrees.list(agent)` returns each lease's `path`, `branch`, and `status`, which is `live`, `dead`, `foreign`, `kept`, `unowned`, or `missing`. `ctx.worktrees.reap(agent)` settles every `dead` lease in the caller's repository and returns the settlements. `isolate` runs the same sweep first and reports leases a crashed run of the same Session left kept. Names under `dsh/lease/` belong to leases; `create` rejects them and `namePrefix` may not use them.

The default checkout directory is `<current checkout root>/.agents/worktrees/<name>`. The returned `repositoryRoot` is the top-level directory of the caller’s current checkout; when it is a linked checkout, the pool is nested inside it. Omitted names use `worktree-` plus a UUID. The service writes a `.gitignore` containing `*` and a trailing newline only when its allocation creates the pool; existing files and ignore rules are preserved. Relative `directory`, generated `namePrefix`, executable choices, and process limits are configurable in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-worktree).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Git and directory allocation run through the mounted subprocess and sandbox providers with the calling Session's existing file policy. Creation does not widen write access to the destination or shared Git administration directory. Directory creation claims the destination exclusively; cancellation and failed setup can leave retained artifacts, whose path appears in the error. Service disposal aborts pending operations and waits for their settlement.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Resolve the source revision, create the checkout, and publish the new working directory |
| [`src/lease.ts`](src/lease.ts) | Pure ownership classification, settle decision, orphan decision, and worktree list parsing |
| [`src/owner.ts`](src/owner.ts) | Host name, process start time, and owner liveness |
| [`src/process.ts`](src/process.ts) | Confine literal argv, cap output, and await process termination |
| [`src/directory.ts`](src/directory.ts) | Claim the destination, initialize a newly created pool's ignore file, and replace the lease metadata file atomically |

A lease is a linked worktree on a `dsh/lease/` branch plus one file, `dsh-lease.json`, in that worktree's own Git administration directory. Git deletes the file with the worktree, so metadata cannot outlive what it describes. The file records `provisioning`, `held`, `settling`, or `kept`, the owning Session, host, pid, process start time, and base commit. A confined `workspace-write` policy permits the write whenever it permits `git worktree add`, so leases add no write grant. Liveness is host, pid, and process start time: a lease on another host is never reaped, a live pid with the recorded start time is never reaped, and an unreadable start time counts as alive. There is no heartbeat and no expiry. A lease with missing or unparsable metadata is `unowned` and untouched.

Sweeps replay interrupted transitions. A dead `provisioning` lease finishes its checkout and then settles. A `held` or `settling` lease whose owner died settles like any other. A lease branch whose worktree vanished is deleted only when its oldest reflog entry is `branch: Created from` and equals the branch tip. Provisioning and sweeps run one at a time inside a service. Settlement and sweeps use the same filter-disabled Git environment as creation, so repository filters and hooks never run.

No runtime invariant companion is published: Git owns checkout registration and the working-directory service owns the Session directory; this package retains no independent projection of either beyond the per-worktree metadata file.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Worktree subsystem](../../../docs/subsystems/worktrees.md) — request, result, and service reference.
- [Working directory](../../session/working-directory/README.md) — recorded Session directory and directory changes.
- [Worktree tool](../tool-worktree/README.md) — model-facing creation.
- [Subprocess](../../subprocess/subprocess/README.md) — process ownership and execution worlds.
- [Creation decision](../../../.agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.md) — retained checkouts and existing write grants.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the worktree tool's creation result and the working-directory service's recorded Session context. A consumer that calls `isolate` owns the child's directory note and the kept-checkout message it builds from `onKept`.

#### KV Cache effect

This package contributes no prompt text. Its consumers own the appended tool result and recorded directory context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Retained artifacts** — leaving a worktree keeps its branch and files. Setup failures can also retain partial artifacts; removal, pruning, and branch deletion belong to the user or another consumer.
- **Kept leases accumulate** — a checkout with changes is never removed automatically. `list` and `git worktree list` show them, and a human merges or deletes each one.
- **Lease crash windows** — a process killed between `git worktree add` and the first metadata write leaves an `unowned` lease that no sweep touches. A lease whose directory was deleted by hand is `missing`; `git worktree prune` clears it. A service disposed while a delegate still runs does not settle that lease; the next sweep settles it after the process exits.
- **Same host only** — leases recorded under another host name are skipped, including on shared filesystems.
- **Stale remote default** — `remote-default` reads local remote-tracking refs and never fetches.
- **Local revisions only** — creation does not fetch commits or missing partial-clone objects, initialize submodules, install dependencies, or copy uncommitted files. On Git that meets the execution requirements, missing local objects cause creation to fail.
- **Filtered representations** — checkout skips configured filters to avoid executing repository-configured programs or triggering implicit downloads. Git LFS pointers and encrypted blobs stay in their stored representation; hydration or decryption is a separate user-controlled operation.
- **Execution requirements** — the subprocess provider must offer Git and Node in the same execution world as the filesystem provider. Git must honor `GIT_NO_LAZY_FETCH`, which Git 2.45 and the 2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, and 2.44.1 maintenance releases do; older releases ignore it and proceed instead of failing, so creation can fetch missing partial-clone objects from a promisor remote. The `git --no-lazy-fetch` option would reject these releases, but it exists only in Git 2.45 and later and also rejects the patched maintenance releases. The existing sandbox must permit all checkout and shared Git metadata writes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The sandboxed Node child supplies exclusive directory creation, which the [filesystem service](../../fs/fs/src/index.ts) does not expose, and identifies whether this service created the pool. The filesystem contract permits bare providers such as [fs-local](../../fs/fs-local/src/index.ts) to ignore `sandboxPolicy` on writes; `createIfAbsent` protects a file but neither enforces permissions nor identifies who created its directory. Keeping directory allocation and ignore-file creation under the same process sandbox as Git preserves refusal of existing checkout paths and the condition for creating `.gitignore`.

</details>
