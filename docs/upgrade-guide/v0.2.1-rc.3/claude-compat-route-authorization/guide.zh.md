---
kind: upgrade-guide
description: "claude_agent 的显式模型及档位选择现在要求已记录的会话路由授权，不再绕过该授权。"
---

# 授权 claude_agent 的显式模型路由

[English](guide.md) | 中文

## 变更

`claude_agent` 以前会为显式路由绕过会话模型选择策略，包括模型别名。显式别名、原始模型及档位选择现在与原生委派一样，执行 `subagent/model-selection-policy`。没有记录策略时，仅允许当前父级的 provider/model 对。别名不授权其路由，compat 的 `modelSelection: true` 也不授予权限。

原生 profile 现在内置 pstack skill 与 agent，并在全局偏好文件缺失时创建该文件，不再要求外部安装，也不再保持初始化不启用的状态。已有配置仍选择其外部根目录。

当 compat 设置 `modelSelection: false` 时，与已配置类型或通配路由冲突的请求现在会失败，而不是静默使用配置路由。选定的子 agent 选项会根据实时目录预检，包括支持的推理档位。

## 迁移

1. 原生 pstack 可移除仅用于 pstack 的 `--patch` 覆盖层。父级凭据可用时，启动会在 `$DSH_HOME/pstack/config.json` 缺失时创建该文件；已有偏好和外部根目录保持不变。使用 `setup-pstack` 保存角色与目录中的模型别名。新增路由需要通过 `userQuestions` 直接确认，并且仅选择 `Authorize routes`。拒绝或无法确认时不保存。参见[全局设置](../../../../packages/context/claude-compat/README.zh.md#global-pstack-setup)。
2. 在设置过程中确认显式别名或档位选择需要的精确 provider/model 对，无需手工编辑。Host `subagent-model-selection-settings` 的 `enabled: false` 在查询来源前禁止授权，`enabled: true` 仅使用显式 host 路由，`enabled: null` 则使用注册来源。没有保存的别名或授权时，内置默认配置使用父级路由，不会虚构别名或授予其他模型的访问权限。

3. 设置只对全新的顶层会话生效。经确认的 `claude_agent_setup` 会立即扩大其所在的运行中会话，并注入新的角色表；编辑配置文件不会扩大任何会话。更早启动的子会话和其他已打开的会话保留原有授权；之后启动的子会话继承父级当前的策略。
4. 对于高级手工挂载，除非需要原始 provider/model 覆盖或覆盖已配置的类型路由，否则保持 compat 的 `modelSelection: false`。该值为 false 时，移除冲突选择或使其与配置路由一致。仅使用精确选定模型公布的推理档位。
5. 在执行设置的会话或全新会话中确认发现与派发：使用 `claude_agent_models` 查看别名授权和精确模型档位，然后分别用授权别名运行一个通用及一个具名 `claude_agent` 任务。两者都应返回子 agent id 并投递完成消息。已记录策略未包含的显式路由必须在子 agent 启动前失败。参见[权威运行时映射](../../../../packages/context/claude-compat/README.zh.md#dsh-runtime-mapping-for-pstack)。

直接调用 JavaScript API 时，现在必须等待 `install(host, config)` 和 `savePstackPreferences(update, approval?)`。安装会在读取偏好前初始化目录。保存仍接受相同的 JSON 编辑，但返回 `Promise<string>`，并可能拒绝过期的并发快照；此时应重新发现并获得新的确认，而非重用旧批准。`loadPstackPreferences()` 保持同步，在文件不存在时初始化安全的空默认值。
