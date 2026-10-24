---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-24-worktree-kept-attribution

[English](2026-10-24-worktree-kept-attribution.md) | 中文

## 概述

新增 worktree-kept 消息来源类型，用于持久化委派检出目录被保留的报告。共享来源联合类型影响 user/message、developer/message、agent/inbox/spliced 和 session/title-llm-request，但不改变会话格式版本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有来源分支和记录的含义保持不变。新读取方无需修改即可接受历史记录。旧读取方将生产方归属校验为非空 kind 字符串，保留未知来源 JSON，并在未安装生产方的情况下派生用户和开发者消息内容。同一消息来源校验覆盖排队的收件箱消息和已存储的标题请求消息。worktree-kept 类型仅为普通文本添加归属信息，不要求回放处理器，也不授予权限。日志中没有 worktree-kept 报告时，已有行为保持不变。原生来源读取方与新增此类型前的读取方逐字节一致。

<a id="verification"></a>
## 验证

`pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/attribution.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts packages/context/claude-compat/tests/worktree-lifecycle.spec.ts` 的全部 35 个测试通过。[归属测试](../../packages/session/session-format-v3-to-v4/tests/attribution.spec.ts)覆盖未知用户和开发者归属信息的编解码器解码与分离派生。其余测试覆盖未知排队来源元数据的 JSONL 读写，以及可选工作树服务替换。`pnpm exec vitest run --config vitest.e2e.config.ts --retry 0 packages/context/claude-compat/tests/worktree-isolation.e2e.ts` 的两个测试均通过。真实 headless Loader 在子代理回答后持久化父级和嵌套 worktree-kept 通知，并在取消时完成含修改租约的结算。

<a id="dev-note"></a>
## 开发备注

无。
