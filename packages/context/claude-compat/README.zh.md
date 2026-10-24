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
- [pstack 的 DSH 运行时映射](#dsh-runtime-mapping-for-pstack)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

原生 pstack 使用下文的[全局设置](#global-pstack-setup)。手工挂载插件适用于其他 Claude 插件或高级 profile 定制：在 tools 与 subagent 注册表之后挂载，把 `roots` 指向一个或多个插件目录。

```yaml
- id: claude-compat
  name: '/absolute/path/to/harness/packages/context/claude-compat/src/index.ts'
  config:
    roots:
      - '~/.agents/pstack-plugin'
    provider: spawn
    hooks: true
```

手工配置行使用绝对源码路径，因为本包尚未发布，且其 peer 依赖为 `workspace:*`，profile 安装无法解析。[`example-overlay.yml`](example-overlay.yml) 提供这种可选的高级 `--patch` 配置；原生 pstack 无需每次启动都传入 patch。

目录按 Claude Code 的读法读取：`.claude-plugin/plugin.json` 提供 `subagent_type` 中的命名空间，`agents/*.md` 与 `effort-agents/*.md` 提供具名类型，`hooks/hooks.json` 提供 hook 配置。没有 manifest 的根目录以目录名作为命名空间。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `roots` | `[]` | 按优先级排列的额外插件根目录；`~` 会被展开。全局 pstack 资源另行加载。 |
| `provider` | `spawn` | 每次派发使用的 `ctx.subagents` provider。 |
| `models` | `{}` | 按类型配置的路由：`{ provider, model, reasoningEffort? }`。`"*"` 为兜底；未列出的类型继承父级路由。 |
| `modelAliases` | `{}` | 将仅含模型名的别名映射到 `{ provider, model, reasoningEffort? }`；没有内置模型兜底。 |
| `pstack` | 未设置 | 原生初始化：`{ root, sheetPath }`；无需 Claude 子进程即可读取已安装的指令文件与配置的模型选择表。 |
| `modelSelection` | `false` | 允许原始 provider/model/effort 参数覆盖 `models`。 |
| `hooks` | `true` | 为每个带 `hooks/hooks.json` 的根目录挂载 `dsh-hooks-claude-code` 桥。 |
| `projectDir` | 会话目录 | 传给 hook 命令的 `CLAUDE_PROJECT_DIR`。 |

<a id="global-pstack-setup"></a>
### 全局 pstack 设置

原生 profile 随 DSH 提供 pstack skill 与 agent 声明，无需安装外部插件、传入 `--patch` 或使用项目本地配置。启动时，DSH 会在 `$DSH_HOME/pstack/config.json` 不存在时创建该文件；`DSH_HOME` 默认为 `~/.dsh`。文件中的绝对路径 `root` 指向内置资源。已有文件保留其配置的外部根目录与偏好；这些路径不依赖工作目录。

内置资源的[引入清单](resources/pstack/upstream.json) 记录上游版本、来源归属、文件校验和，以及保留的许可证与声明文件。

首次使用时，请让 agent 执行 `setup-pstack`。它使用 `claude_agent_models` 发现 provider/model id 及模型支持的档位，询问你希望使用哪些模型，然后调用 `claude_agent_setup`，将包含 `modelAliases` 和 `roles` 的 JSON 字符串作为 `preferences_json` 传入，还可提供 `defaultEffort` 和 `sessionHook`。如果不需要额外模型路由，可保留继承角色。对于新增别名路由，host 通过 `userQuestions` 请求用户直接确认：仅选择 `Authorize routes` 才会将这些路由保存到 `allowedModels`。取消或无法确认时，已保存的偏好保持不变。每次调用 `claude_agent` 和 `claude_agent_models` 都会重新读取别名。确认保存后，当前会话立即持有新路由：其策略修订号加一，且 `claude_agent_setup` 会注入一份取代此前所有角色表的新角色表。一次提问涵盖已保存偏好或本会话尚未包含的全部路由；两者都已包含的路由无需提问。授权只来自该回答。手工编辑 `config.json`（包括经由模型的 shell）不会改变运行中的会话。这一边界针对的是模型的工具调用：拥有 shell 权限的模型仍可编辑自己的会话日志，这与在新会话启动前编辑 `config.json` 属同一类，本处的检查无法阻止能够写入你文件的行为者。更早启动的子 agent 和其他已打开的会话保持原有授权，之后启动的子 agent 继承扩大后的集合。注入的角色表是模型上下文，压缩可能将其摘要，恢复会话时会以新表替换；`claude_agent_models` 返回当前的 `roles`、`defaultEffort`、`policyRevision` 和 `sheetDigest`，并以此为准。显式 profile 别名优先于保存的别名。更新插件代码本身时，如果未启用代码热重载，仍需重新加载插件或重启 host；实时读取偏好不会重新加载代码。

生成的文件没有别名或额外授权路由。所有内置角色继承父模型，多成员面板保留各自独立的继承条目，`defaultEffort` 为 `session`，`sessionHook` 为 `true`。模型设置完成前，委派继承父路由，不会虚构别名。偏好无效或配置的根目录缺少指令文件时会失败，而非静默回退。

DSH 不会自动提供 API key 或服务商账号。启动会话前，请配置可用的父模型与服务商凭据；设置流程发现现有实时模型目录，不会安装服务商或验证凭据。

运维人员可维护以下完整文件；请将示例根目录与路由 id 替换为实际安装及目录中的值：

```json
{
  "version": 1,
  "root": "/absolute/path/to/pstack-plugin",
  "modelAliases": {
    "fast": { "provider": "local", "model": "deepseek-v4.1-flash" }
  },
  "roles": {
    "default": "fast",
    "review panel": "fast@high, inherit-parent"
  },
  "allowedModels": [
    { "provider": "local", "model": "deepseek-v4.1-flash" }
  ]
}
```

`version` 必须为 `1`。别名使用字母、数字、`_` 或 `-`；`auto` 和 `inherit-parent` 为保留名。角色值包含已知别名或上述继承路由标记，可带 `@effort` 后缀并以逗号分隔。无效 JSON、未知字段、未知角色别名、相对根路径及重复授权组合均会被拒绝。设置工具还会根据实时目录验证别名路由及其配置的档位；发现目录不代表凭据已验证。

高级手工挂载时，显式 `pstack: { root, sheetPath }` 选择旧式模型选择表，而非全局偏好。否则，profile 的 `modelAliases` 覆盖同名全局别名，配置的根目录与全局根目录合并。会话授权以 host 模型选择设置为准；参见[保存的模型、档位与授权](#saved-models-effort-and-authorization)。

### 把角色路由到配置里已保存的模型

```yaml
models:
  '*': { provider: local, model: glm-5.3, reasoningEffort: high }
  'pstack:comment-sicko': { provider: local, model: deepseek-v4.1-flash }
```

派发前会根据实时模型目录预检选定的子 agent 选项。不支持的推理档位会导致失败，而不是静默降级。会话策略负责授权显式模型或档位选择；没有显式选择时，运维配置的默认值与此授权分开处理。

### 模型别名与原生 pstack 上下文

`modelAliases` 可配置任意名称，包括 `opus`、`fable`、`sonnet` 或 `haiku`；这些名称均非内置。未知别名会导致失败，并列出可用别名。`modelSelection: false` 时，精确类型路由优先，其次是通配路由，且两者具有决定权：冲突的模型请求会失败，而非被忽略。`modelSelection: true` 时，显式选择可覆盖这些路由。通用、具名及 effort agent 的别名解析方式相同；别名不授予会话权限。

设置 `pstack: { root: '~/.agents/pstack-plugin', sheetPath: '/absolute/path/to/pstack-models.md' }` 可在初始化时注入保存的角色行和原生工具使用说明。已安装的 `hooks/session-start-context.md` 仅为根 agent 提供 poteto-mode 指令。完全匹配 `session hook: off` 的行只会禁用该指令，不影响角色选择或工具使用说明。模型选择表支持 UTF-8 BOM、UTF-16LE BOM 和 CRLF。缺失文件会导致失败，而不是静默选择模型。即使 `hooks: false`，上下文仍然启用；开启 hook 时，只跳过该根目录经桥接的 SessionStart，其他 hook 点保持启用。

### 模型看到什么

`claude_agent` 取代参考实现中的 `Agent` 调用：同样的 `subagent_type`、`description`、`prompt`，外加可选的 `cwd`。工具描述会列出所有已发现的类型，并标注已固定路由的类型，因此模型不必猜测某个类型是否存在。

<a id="dsh-runtime-mapping-for-pstack"></a>
## pstack 的 DSH 运行时映射

本节是将 pstack 指令适配到原生 DSH 运行时的权威参考。内置 pstack 资源或显式配置的外部根目录提供声明与 skill；DSH 提供派发、授权、消息传递及完成结果投递。

### Agent 类型与 skill

所有 pstack `Agent` 调用都使用 `claude_agent`，包括通用面板成员，不要与标准 `subagent` 工具混用。通用任务可省略 `subagent_type`，或使用 `general-purpose`。具名类型使用发现结果中的精确命名空间和声明名。对于内置的 pstack 声明，四个基础类型为 `pstack:poteto-agent`、`pstack:comment-sicko`、`pstack:thermo-nuclear-review-subagent` 和 `pstack:thermo-nuclear-code-quality-review-subagent`。

十个 effort 类型为 `pstack:effort-low`、`pstack:effort-medium`、`pstack:effort-high`、`pstack:effort-xhigh`、`pstack:effort-max`，以及 `pstack:poteto-agent-low`、`pstack:poteto-agent-medium`、`pstack:poteto-agent-high`、`pstack:poteto-agent-xhigh`、`pstack:poteto-agent-max`。加上四个基础类型，共有 14 个发现的具名类型，另有原生 `general-purpose`。发现结果取决于所选资源文件；当前会话可用的类型以工具描述为准。声明的档位适用于选定模型，包括继承的模型；不支持的档位或与显式档位冲突都会导致失败。

通过 `skill` 使用目录中的精确名称加载 skill。如果 skill 目录暴露的是裸名，pstack 指令中的 `pstack:poteto-mode` 就对应 `poteto-mode`；不要虚构带命名空间的名称，也不要假设 agent 声明会注册 skill。

<a id="saved-models-effort-and-authorization"></a>

### 保存的模型、档位与授权

使用全局 `modelAliases` 和 `roles`，或显式旧式 `pstack: { root, sheetPath }` 配置。对于保存的每个角色或面板条目，将别名作为 `model` 传入，不传 `provider`。没有具有决定权的配置路由时，`auto` 和 `inherit-parent` 选择父模型。将 `@effort` 后缀拆为单独的 `reasoning_effort` 参数，或使用对应的 effort-agent 声明。无后缀的条目使用模型选择表的默认档位；没有默认值或值为 `session` 时，必须传入 `reasoning_effort: session`。该标记保留父级档位，而不是别名配置的档位，并根据目标模型校验该档位。这种模型选择表解释方式是给委派 agent 的指令，并非自动将表解析为派发请求的程序。不要合并面板条目，包括重复的继承条目。

别名标识路由，不代表权限。显式别名、原始模型或档位选择必须解析到已记录的 `subagent/model-selection-policy` 授权的精确 provider/model 对；没有记录策略时，仅允许当前父级组合。纯继承不需要显式选择。`modelSelection` 控制原始路由覆盖及配置路由优先级，不控制会话权限。

全局 `allowedModels` 包含通过设置流程批准或由运维人员配置的精确路由。Host `subagent-model-selection-settings` 的 `enabled: false` 在查询来源前禁止授权；`enabled: true` 仅使用显式 host 路由，`enabled: null` 则使用注册来源。手工挂载时，在其 `allowedModels` 列表中配置精确 `{ provider, model }` 对。设置工具不能覆盖该 host 策略，也不接受模型提供的 `allowedModels`。设置在全新顶层会话创建时采样，子 agent 继承该策略；更改设置不会扩大现有会话已记录的策略。只有经确认的 `claude_agent_setup` 才会扩大运行中的会话，且从不缩小：每次被接受的扩大都会追加一条保留此前全部路由的 `subagent/model-selection-policy` 条目。参见[路由授权升级指南](../../../docs/upgrade-guide/v0.2.1-rc.3/claude-compat-route-authorization/guide.zh.md)。

执行 `setup-pstack` 时，使用 `claude_agent_models` 发现已配置的别名、每个别名的精确路由、会话授权（`allowed`）、支持的 `efforts` 及公布的 `defaultEffort`（如有），以及继承路由和当前的 `roles`、`defaultEffort`、`policyRevision`（已记录策略时）及 `sheetDigest`。提供已授权的配置别名，以及 `auto` 和 `inherit-parent`；目录可用不代表凭据已验证。保存的别名拼写会保留，包括大写字母。元数据查询失败会在该别名上返回错误及 `allowed: false`，而不会隐藏其他别名。不要根据其他模型的能力推断 `max`、`xhigh` 或其他档位是否受支持。原生 `list_subagent_models` 提供策略授权的原始路由，不提供 compat 别名。原始 provider/model 选择还要求 compat 设置 `modelSelection: true`。

### Readonly 与工作目录

`readonly: true` 向子 agent 传递 `toolFilter: { deny: ['edit', 'write'] }`，并要求它不修改文件或外部状态，包括不通过 shell 命令修改。直接 `edit` 和 `write` 会从可用工具中移除。Bash 仍然可用：这不是只读文件系统或 shell 沙箱，不能阻止所有可能的修改。Spawn 和 fork 支持该过滤器，包括冷恢复后；没有 `toolFilter` 能力的 provider 会拒绝请求。

传入 `cwd` 可选择子 agent 的工作目录；省略时使用父级目录。挂载实验性 [worktree 服务](../../experimental/worktree/README.zh.md) 后，`claude_agent` 还接受 `isolation: worktree`。服务相对于父级目录解析 `cwd`，创建独立检出目录，并仅在该目录启动子 agent。父级目录保持不变。服务的 `baseRef` 选择基线，默认使用本地远程默认分支，不执行 fetch；回退到 HEAD 时会明确报告。

子 agent 停止后，干净的检出目录及其分支会被删除。有改动的检出目录会保留；子 agent 答案之后，单独的 `worktree-kept` 消息报告路径、分支、提交和未提交状态。在 Git 之外或仓库尚无提交时，子 agent 在选定目录运行，初始工具结果会明确报告隔离降级。添加、移除或替换服务会刷新 `claude_agent` schema。未挂载服务时，schema 省略 `isolation`，执行器也会拒绝该参数，包括在移除前已获准执行的工具。仅设置 `cwd` 不会创建 worktree。保留目录的审查、合并、依赖安装和删除仍需手工执行。

### 后台结果与控制

每次 `claude_agent` 派发都是异步的。`run_in_background: true` 与省略该参数都会返回子 agent id；`run_in_background: false` 会被拒绝。最终答案通过完成消息自动投递，不在初始工具结果中返回。使用 `dsh-tool-subagent-control` 提供的原生控制工具：

| pstack 指令 | DSH 操作 | 含义 |
|---|---|---|
| `SendMessage` | `send_message(agent_id, message)` | 返回消息接收确认，而非回复。工作的本地目标在下一步接收引导；空闲的直接子 agent 启动新一轮。 |
| `TaskStop` | `interrupt_agent(agent_id)` | 请求中断；返回接收确认，不等待退出或静止。本地子 agent 停止当前轮，仍可继续；后代不会自动停止。 |
| `TaskOutput` | `list_agents` 加自动完成消息 | 列出状态，而非获取或等待最终答案。完成消息包含结果。 |

不存在 `stop_subagent` 控制工具。父 agent 可向可继续运行的直接子 agent 发消息；驻留子 agent 可向直接父 agent 发消息。祖先可中断运行中的后代。持久化、会话查询及已记录的组合可用时，本地继续运行可冷恢复不活跃的直接子 agent；这不保证能恢复任意 id 或外部一次性后端。`list_agents` 本身不会加载或恢复子 agent，且不列出一次性子 agent。限制详见[原生控制](../../subagent/tool-subagent-control/README.zh.md)和[子 agent 组合恢复](../../subagent/subagent/README.zh.md#restoring-child-composition)。

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

`claude_agent` 描述原生 `general-purpose` 及每个发现的具名类型，并在配置固定路由时附加标记。参数包括 `subagent_type`、`description`、`prompt`、`cwd`、`model`、`reasoning_effort`、`readonly` 与 `run_in_background`；仅当 `modelSelection` 开启时暴露 `provider`。没有发现声明时，通用派发仍然可用。

#### Token 影响

每个已发现的类型对应一行描述；插件根目录越大，目录按比例增长。该文本由配置推导且在轮次之间完全一致，因此只支付一次，并留在可复用的前缀中。

#### KV Cache 影响

只要挂载的根目录与路由不变就保持稳定。重新加载后出现新类型或不同的固定路由，描述随之改变，进而产生新的前缀。

### 被派发的子 agent

#### 模型看到什么

子 agent 的初始任务包含 agent 声明、委派任务及只读指令（如有）。父 agent 先收到类型、子 agent id 与路由，随后收到包含最终答案的完成消息。子 agent 的内部轮次保留在自身会话中。默认 spawn provider 不复制父级历史。

#### Token 影响

父 agent 支付一条简短的工具结果。子 agent 支付自身的完整上下文：声明、任务以及 provider 的 system prompt。固定路由既不增加也不减少父侧 token。

#### KV Cache 影响

派发不会改变父侧的请求前缀。位于父路由上的子 agent 可以复用父侧在 provider 端的缓存谱系；固定到另一个模型的子 agent 则开启独立谱系，与父侧不共享任何内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `paths:` frontmatter 仍然无效：按 glob 自动附加属于 `dsh-tool-skill` 的消费者行为。
- 人格文本随子 agent 的 prompt 传递，而不是 system prompt。
- 发现只在插件加载时读取一次 `agents/*.md` 和 `effort-agents/*.md`；新增声明需要重新加载。
- 原生模型选择表上下文只包含简单的角色行，不处理任意 Markdown；它不会校验完整的上游面板/角色 schema。
- hook 桥只运行命令 hook，与 `dsh-hooks-claude-code` 已记录的子集一致。

<a id="dev-note"></a>
### 开发备注

`tests/e2e.ts` 不属于 vitest 套件：它会针对 `llm-mock-server` 启动真实的 headless profile，耗时数秒。改动派发或路由后请手工运行：

```sh
node --import tsx/esm packages/context/claude-compat/tests/e2e.ts
node --import tsx/esm packages/context/claude-compat/tests/pstack-native.e2e.ts
E2E_MODEL_ROUTE=deepseek-official/deepseek-v4-flash \
  node --import tsx/esm packages/context/claude-compat/tests/e2e.ts
```
