---
kind: upgrade-guide
description: "claude_agent 的显式模型及档位选择现在要求已记录的会话路由授权，不再绕过该授权。"
---

# 授权 claude_agent 的显式模型路由

[English](guide.md) | 中文

## 变更

`claude_agent` 以前会为显式路由绕过会话模型选择策略，包括模型别名。显式别名、原始模型及档位选择现在与原生委派一样，执行 `subagent/model-selection-policy`。没有记录策略时，仅允许当前父级的 provider/model 对。别名不授权其路由，compat 的 `modelSelection: true` 也不授予权限。

当 compat 设置 `modelSelection: false` 时，与已配置类型或通配路由冲突的请求现在会失败，而不是静默使用配置路由。选定的子 agent 选项会根据实时目录预检，包括支持的推理档位。

## 迁移

1. 原生 pstack 不再需要每次启动都传入 `--patch`。将现有别名和角色选择一次性保存到 `$DSH_HOME/pstack/config.json`（默认为 `~/.dsh/pstack/config.json`），包含 `version: 1`、绝对安装路径 `root`、`modelAliases`、`roles`，以及运维人员管理的 `allowedModels`。使用 `setup-pstack` 交互选择模型：`claude_agent_models` 发现可选项，`claude_agent_setup` 保存别名和角色，并在向 `allowedModels` 添加新增别名路由前通过 `userQuestions` 请求用户直接确认。仅选择 `Authorize routes` 才会批准；取消或无法确认时不保存任何内容。参见[全局设置与完整文件示例](../../../../packages/context/claude-compat/README.zh.md#global-pstack-setup)。
2. 在设置过程中确认显式别名或档位选择需要的精确 provider/model 对，无需手工编辑。Host `subagent-model-selection-settings` 的 `enabled: false` 在查询来源前禁止授权，`enabled: true` 仅使用显式 host 路由，`enabled: null` 则使用注册来源。没有保存的别名或授权时，默认安装使用父级路由，不会虚构别名或授予其他模型的访问权限。

3. 更新设置后启动全新的顶层会话。现有会话保留其已记录的授权；重新加载配置不会扩大授权。子会话继承父级策略。
4. 对于高级手工挂载，除非需要原始 provider/model 覆盖或覆盖已配置的类型路由，否则保持 compat 的 `modelSelection: false`。该值为 false 时，移除冲突选择或使其与配置路由一致。仅使用精确选定模型公布的推理档位。
5. 在新会话中确认发现与派发：使用 `claude_agent_models` 查看别名授权和精确模型档位，然后分别用授权别名运行一个通用及一个具名 `claude_agent` 任务。两者都应返回子 agent id 并投递完成消息。已记录策略未包含的显式路由必须在子 agent 启动前失败。参见[权威运行时映射](../../../../packages/context/claude-compat/README.zh.md#dsh-runtime-mapping-for-pstack)。
