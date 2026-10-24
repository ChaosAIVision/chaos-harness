# Agent Note: Compat delegate worktree isolation

Status: implemented

English | [中文](2026-10-24-compat-delegate-worktree-isolation.zh.md)

## Problem

Parallel pstack delegates share their parent's checkout unless callers allocate directories themselves. The explicit creation operation enters and retains a checkout, so using it for delegation changes the parent's working directory and leaves cleanup ownership unclear.

## Decision

This note partially supersedes the rejection of automatic subagent isolation in [explicit worktree creation](2026-09-13-explicit-worktree-creation.md). The `claude_agent` consumer accepts an explicit `isolation: worktree` request only when the experimental worktree service is mounted. Ordinary delegation and Agent Teams keep their current behavior. The existing `create_worktree` operation still enters and retains a human-selected checkout.

The service owns the lease, baseline selection, crash recovery, and settlement. Compat passes the resolved lease directory only to the child and keeps the parent's directory unchanged. Compat uses parent result delivery so the child's answer reaches the caller, then sends a separately attributed `worktree-kept` notice for retained work. These runtime notices cannot be mistaken for words authored by the child.

Compat owns the settlement promises per parent and joins them through the serial `agent/turn-stopping` event. A resident parent cannot close between its child's answer and the kept notice. The worktree service owns each admitted isolate call through provisioning and settlement, so profile teardown retains its injected providers until Git cleanup finishes. Activation owners still stop their children; a service caller that never settles its result prevents disposal from reaching quiescence.

The released compat package consumes an optional capability without importing experimental runtime code or exposing experimental types in its published declarations. Its Loader adapter reads the mounted service through `ctx.get('worktrees')`. Absence removes the schema field and independently rejects direct executor requests.

## Alternatives considered

**Enter a checkout before delegation.** The explicit operation changes the caller's directory and has intentional retain-on-exit semantics. A delegate lease instead belongs to that activation.

**Always create a checkout for delegates.** Read-only exploration often needs the parent's working files. Isolation remains an explicit request, and a non-Git source visibly degrades to the requested directory.

**Return only to the tool caller.** Caller delivery omits the child's automatic completion message. Keeping parent delivery preserves the normal background result path.

## Consequences

Clean leases disappear after completion. Changed leases remain for manual review and merging. Dependency installation is separate, and the service's `baseRef` remains the single baseline setting. Keyless Loader tests exercise real Git and real child activations with a scripted external model, including parallel checkout separation, visible degradation, failed activation cleanup, answer-before-notice ordering, nested parent delivery, and cancellation teardown.
