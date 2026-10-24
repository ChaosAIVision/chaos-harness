---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-24-model-selection-policy-widening

English | [中文](2026-10-24-model-selection-policy-widening.zh.md)

## Summary

Adds optional origin and revision to the subagent/model-selection-policy event so a human-approved setup can widen a running Session's route set.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-24-model-selection-policy-widening
baseline: false
changes:
  - root: "event:subagent/model-selection-policy"
    previous: "2026-09-11-initial"
    after: "1d752c20c7ef65360044a82be046a49981f3b980dbaf0f525e795a6440be4c2b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Older logs without origin or revision read as a session-start entry at revision 1. Older readers parse newer logs because both fields are optional, but they keep the first entry and never apply a widening, so they fail closed to the narrower route set. The projection state version moves to 2 and discards version 1 checkpoint rows, which refold from the full log.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/subagent/tool-subagent/tests/model-selection-policy-log.spec.ts: legacy entry, ignored entries, version 1 checkpoint refold, and suffix replay equal full replay.

<a id="dev-note"></a>
## Dev Note

None.
