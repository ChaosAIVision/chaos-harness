# Agent Note: Compat 委派 worktree 隔离

Status: implemented

English | [中文](2026-10-24-compat-delegate-worktree-isolation.md)

## Problem

除非调用方自行分配目录，并行 pstack 委派会共享父级检出目录。显式创建操作会进入并保留检出目录，因此用于委派时会改变父级工作目录，并使清理责任不明确。

## Decision

本记录部分取代[显式 worktree 创建](2026-09-13-explicit-worktree-creation.zh.md)对自动子 agent 隔离的否决。只有挂载实验性 worktree 服务后，`claude_agent` 消费方才接受显式 `isolation: worktree` 请求。普通委派和 Agent Teams 保持现有行为。现有 `create_worktree` 操作仍会进入并保留人工选择的检出目录。

服务负责租约、基线选择、崩溃恢复和清理结算。Compat 仅向子 agent 传入解析后的租约目录，父级目录保持不变。Compat 使用父级结果投递，使答案到达调用方，再为保留的工作发送单独归属的 `worktree-kept` 通知。这些运行时通知不会被误认为子 agent 撰写的内容。

Compat 按父级持有结算 Promise，并通过串行 `agent/turn-stopping` 事件等待完成。驻留父级不会在子级答案与保留通知之间关闭。Worktree 服务持有每个已接受的 isolate 调用，覆盖创建和结算阶段，因此 profile 卸载会保留其注入的 provider，直到 Git 清理结束。激活所有者仍负责停止子级；若服务调用方永不结算结果，释放操作也无法达到静止状态。

已发布的 compat 包消费可选能力，不导入实验性运行时代码，也不在已发布声明中暴露实验性类型。其 Loader 适配器通过 `ctx.get('worktrees')` 读取挂载的服务。服务不存在时，schema 移除该字段，执行器也独立拒绝直接请求。

## Alternatives considered

**委派前进入检出目录。** 显式操作会改变调用方目录，并有意在退出后保留检出目录。委派租约则属于该次激活。

**始终为委派创建检出目录。** 只读探索通常需要父级的工作文件。隔离仍需显式请求，非 Git 来源会明确降级到请求的目录。

**仅返回给工具调用方。** 调用方投递会省略子 agent 的自动完成消息。保留父级投递维持正常的后台结果路径。

## Consequences

干净租约在完成后删除。有改动的租约保留，供人工审查和合并。依赖安装单独执行，服务的 `baseRef` 仍是唯一基线设置。无需密钥的 Loader 测试使用真实 Git、真实子 agent 激活和脚本化外部模型，覆盖并行目录分离、明确降级、激活失败清理答案先于通知的顺序、嵌套父级投递和取消卸载。
