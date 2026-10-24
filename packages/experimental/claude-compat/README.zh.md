---
description: "在 Harness 中直接运行未改动的 Claude Code 插件：它的具名 subagent 类型、按角色配置的模型路由，以及 hooks.json，供选择迁移 Claude 插件而不是重写 skill 的团队使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-claude-compat

[English](README.md) | 中文

## 概述

Claude Code 插件声明了三件 Harness 没有直接对应物的事情：以 `subagent_type` 寻址的 `agents/*.md` subagent 类型、按角色的模型配置表，以及 `hooks/hooks.json` 中的命令 hook。本插件读取一组配置好的 Claude 插件根目录，并基于既有的 `ctx.tools`、`ctx.subagents` 与 hook 接缝提供这三项能力。skill 本身已由 `skill-filesystem` 加载；本包负责插件的其余部分，因此迁移时可以保留原有的目录结构。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 tools 与 subagent 注册表之后挂载本插件，把 `roots` 指向一个或多个插件目录。

```yaml
- id: claude-compat
  name: '/absolute/path/to/harness/packages/experimental/claude-compat/src/index.ts'
  config:
    roots:
      - '~/.agents/pstack-plugin'
    provider: spawn
    hooks: true
```

该行使用绝对源码路径，因为本包尚未发布，且其 peer 依赖为 `workspace:*`，profile 安装无法解析；发布后可直接使用包名。[`example-overlay.yml`](example-overlay.yml) 是同一份配置，可直接用于 `--patch`。

目录按 Claude Code 的读法读取：`.claude-plugin/plugin.json` 提供 `subagent_type` 中的命名空间，`agents/*.md` 提供每个类型，`hooks/hooks.json` 提供 hook 配置。没有 manifest 的根目录以目录名作为命名空间。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `roots` | `['~/.agents/pstack-plugin']` | 按优先级排列的插件根目录；`~` 会被展开。 |
| `provider` | `spawn` | 每次派发使用的 `ctx.subagents` provider。 |
| `models` | `{}` | 按类型配置的路由：`{ provider, model, reasoningEffort? }`。`"*"` 为兜底；未列出的类型继承父级路由。 |
| `modelSelection` | `false` | 暴露 `provider`/`model`/`reasoning_effort`，允许单次派发覆盖 `models`。 |
| `hooks` | `true` | 为每个带 `hooks/hooks.json` 的根目录挂载 `dsh-hooks-claude-code` 桥。 |
| `projectDir` | 会话目录 | 传给 hook 命令的 `CLAUDE_PROJECT_DIR`。 |

### 把角色路由到配置里已保存的模型

```yaml
models:
  '*': { provider: local, model: glm-5.3, reasoningEffort: high }
  'pstack:comment-sicko': { provider: local, model: deepseek-v4.1-flash }
```

多数 provider 都提供 `high` 这一推理档位；模型未列出的档位会被拒绝，而不是静默降级，错误信息会列出可用档位。由模型提供的路由（`modelSelection: true`）会先对实时目录解析，包括该档位列表，因为模型输出不可信。写在配置里的路由属于可信的运维输入：只校验 provider id，模型 id 交给 provider 在派发时自行报错。

### 模型看到什么

`claude_agent` 取代参考实现中的 `Agent` 调用：同样的 `subagent_type`、`description`、`prompt`，外加可选的 `cwd`。工具描述会列出所有已发现的类型，并标注已固定路由的类型，因此模型不必猜测某个类型是否存在。

<a id="understand-the-implementation"></a>
## 理解实现

`install(host, config)` 承载全部决策，`apply` 把 Cordis 上下文适配到很小的 `CompatHost` 接缝：注册工具、启动 activation、读取 LLM 目录、挂载 hook 桥。发现在加载时对每个根目录读取一次；子 agent 在 prompt 开头收到 agent 声明，因为 `SubagentStartRequest` 没有内联 system prompt 的位置。

### 源码映射

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 发现、`claude_agent`、路由解析与校验、hook 挂载。 |
| [`tests/claude-compat.spec.ts`](tests/claude-compat.spec.ts) | 不启动 profile 的行为测试：发现、派发载荷、路由、拒绝路径、hook。 |
| [`tests/e2e.ts`](tests/e2e.ts) | 针对 mock LLM 的手工端到端运行；断言抓取的线上请求与子会话。 |
| [`example-overlay.yml`](example-overlay.yml) | 可直接复制的 insert 片段。 |

<a id="further-exploration"></a>
## 进一步探索

- [Skills 子系统](../../../docs/subsystems/skills.zh.md) — `SKILL.md` frontmatter 如何映射到目录。
- [Subagents 子系统](../../../docs/subsystems/subagent.zh.md) — 本工具派发所依赖的 activation 契约。
- [`dsh-hooks-claude-code`](../hooks-claude-code/README.zh.md) — 按根目录挂载的 hook 桥，包括其命令 hook 子集。

<a id="model-experience"></a>
## 模型体验

### 工具目录条目

#### 模型看到什么

`claude_agent` 及其描述：所有已发现的 `<plugin>:<agent>` 类型，配置了固定路由的类型会附带标注；参数列表（`subagent_type`、`description`、`prompt`、`cwd`，以及仅在 `modelSelection` 开启时的 `provider`/`model`/`reasoning_effort`）。当没有任何根目录包含 `agents/` 时，不会注册任何内容。

#### Token 影响

每个已发现的类型对应一行描述；插件根目录越大，目录按比例增长。该文本由配置推导且在轮次之间完全一致，因此只支付一次，并留在可复用的前缀中。

#### KV Cache 影响

只要挂载的根目录与路由不变就保持稳定。重新加载后出现新类型或不同的固定路由，描述随之改变，进而产生新的前缀。

### 被派发的子 agent

#### 模型看到什么

子 agent 的第一条用户消息以 agent 声明与被委派的任务开头。父 agent 只看到工具结果，其中给出类型、子会话 id 与路由。子 agent 自己的轮次不会进入父上下文，父历史也不会发送给子 agent。

#### Token 影响

父 agent 支付一条简短的工具结果。子 agent 支付自身的完整上下文：声明、任务以及 provider 的 system prompt。固定路由既不增加也不减少父侧 token。

#### KV Cache 影响

派发不会改变父侧的请求前缀。位于父路由上的子 agent 可以复用父侧在 provider 端的缓存谱系；固定到另一个模型的子 agent 则开启独立谱系，与父侧不共享任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `paths:` frontmatter 仍然无效：按 glob 自动附加属于 `dsh-tool-skill` 的消费者行为。
- 显式路由会绕过 `dsh-tool-subagent` 所执行的按会话 `subagent/model-selection-policy` 投影。当会话只授权更窄的集合时，请保持 `modelSelection: false` 并在配置中固定路由。
- 人格文本随子 agent 的 prompt 传递，而不是 system prompt。
- 发现只在插件加载时读取一次；新增 `agents/*.md` 需要重新加载。
- hook 桥只运行命令 hook，与 `dsh-hooks-claude-code` 已记录的子集一致。

<a id="dev-note"></a>
### 开发者注记

`tests/e2e.ts` 不属于 vitest 套件：它会针对 `llm-mock-server` 启动真实的 headless profile，耗时数秒。改动派发或路由后请手工运行：

```sh
node --import tsx/esm packages/experimental/claude-compat/tests/e2e.ts
E2E_MODEL_ROUTE=deepseek-official/deepseek-v4-flash \
  node --import tsx/esm packages/experimental/claude-compat/tests/e2e.ts
```
