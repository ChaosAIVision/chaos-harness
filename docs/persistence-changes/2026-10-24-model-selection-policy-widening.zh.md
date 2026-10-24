---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-model-selection-policy-widening

[English](2026-10-24-model-selection-policy-widening.md) | 中文

## 概述

为 subagent/model-selection-policy 事件新增可选的 origin 与 revision，使经人工批准的 setup 能够扩大运行中会话的路由集合。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

不含 origin 或 revision 的旧日志按 revision 1 的 session-start 条目读取。两个字段均为可选，旧读取方可解析新日志，但只保留首条记录且从不应用扩大，因此以更窄的路由集合安全失败。投影状态版本升至 2，并丢弃版本 1 的检查点行，这些行会从完整日志重新折叠。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/subagent/tool-subagent/tests/model-selection-policy-log.spec.ts：旧条目、被忽略条目、版本 1 检查点重新折叠，以及后缀重放等于完整重放。

<a id="dev-note"></a>
## 开发备注

无。
