---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-worktree-kept-attribution

English | [中文](2026-10-24-worktree-kept-attribution.zh.md)

## Summary

Adds the worktree-kept message-source kind for persisted reports that a delegate checkout was retained. The shared source union changes user/message, developer/message, agent/inbox/spliced, and session/title-llm-request without changing the Session format version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-worktree-kept-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-22-action-card-status"
    after: "1a8c5fd2f5d901e8a7d13871549036816c7937a84f8894b182d01a4a2f7d1051"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "5b17625b775711677b2bb5aa48c659795dd69d518b36d856a3723d583034699d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "0958f6abb7fa75e21ae5eadaf5b7eb8bb72796bd0b3e13d422ba7ed1c5e44694"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "fc50c5fc071a26fba82b18fdb52f64051b17e5d4e3a3f64ea195a6cce2b1c44d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing source alternatives and records retain their meaning. New readers accept historical records unchanged. Older readers validate producer attribution as a nonempty kind string, preserve unknown source JSON, and derive user and developer content without the producer installed. The same message-source validation covers queued inbox messages and stored title-request messages. The worktree-kept kind adds attribution to ordinary text only; it does not require a replay handler or grant authority. When no worktree-kept report exists, existing behavior remains unchanged. The native source reader is byte-identical to the reader before this addition.

<a id="verification"></a>
## Verification

`pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/attribution.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/context/claude-compat/tests/worktree-lifecycle.spec.ts` passed all 35 tests. The [attribution tests](../../packages/session/session-format-v3-to-v4/tests/attribution.spec.ts) cover unknown user and developer attribution through codec decoding and detached derivation. The other tests cover unknown queued source metadata through JSONL reads and writes, and optional worktree-service replacement. `pnpm exec vitest run --config vitest.e2e.config.ts --retry 0 packages/context/claude-compat/tests/worktree-isolation.e2e.ts` passed both tests. The real headless Loader persists parent and nested worktree-kept notices after child answers and settles a dirty lease on cancellation.

<a id="dev-note"></a>
## Dev Note

None.
