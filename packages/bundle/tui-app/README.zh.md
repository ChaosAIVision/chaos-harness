---
description: "通过现有 Harness Web 主机和客户端服务提供交互式终端配置。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-tui-app`

[English](README.md) | 中文

## Summary

`dsh tui` 打开交互式终端应用。其配置仅包含终端客户端。应用通过同一个 `dsh` 可执行文件启动 Web 配置，使用系统分配的回环端口，且不打开浏览器。Web 主机拥有会话、预设、技能、设置、命令和执行状态。终端使用现有类型化 Remote API 和持有引用的客户端会话。

## Use this package

```sh
dsh tui
dsh tui --load
dsh tui --resume SESSION_ID
dsh tui --preset ptc --cwd /path/to/project
dsh tui --connect-url-file /path/to/private-connect-url
```

`--host-profile` 为应用拥有的主机选择兼容 Web 的配置。`--connect-url-file` 则连接现有主机。该文件包含主机的认证 HTTP(S) URL，必须是当前用户所有的普通文件，并禁止组和其他用户访问。不接受符号链接。连接现有主机时，终端不会启动或停止主机。URL 不能通过命令行值传入，也不会显示在终端中。

应用通过临时补丁向其拥有的主机提供私有就绪插件。Loader 完成后，主机通过继承的 IPC 通道发送认证 URL。终端使用该 URL 换取交互式 API cookie，并将 HTTP 请求和 WebSocket 连接限制在所选来源和挂载路径内。每个新连接代次都会重新认证。现有主机授权和会话写锁仍然具有权威性。

关闭终端会释放客户端状态、恢复终端模式，并且只停止终端拥有的主机。子进程在父进程死亡时也会退出，包括启动期间。终端配置中的 `startupTimeoutMs` 和 `shutdownTimeoutMs` 分别设置就绪和关闭时限。启动错误包含长度受限且已脱敏的子进程诊断末尾内容。

斜杠发现包含活动 Host 命令和可调用 skill。名称与终端动作冲突时，`/host:NAME` 和 `/skill:NAME` 保留对原操作的显式访问。子任务历史只使用终端导航，不激活普通 Agent 的命令目录。

## Model Experience

### Existing Web composition

#### What the model sees

所选 Web 配置、预设、会话和命令提供模型上下文。终端渲染不会增加模型提示或工具策略。

#### Token effect

传输层和终端渲染不增加模型 token。执行的命令和选用的预设保留各自原有的模型影响。

#### KV Cache effect

终端不改变请求前缀。现有主机组合和会话变更决定缓存复用。

## Known Limitations and Deferred Work

应用需要交互式终端。文档通过文本、表格和导航视图呈现，不复现浏览器布局或 PDF 页面图像。主机重启后，其启动 URL 失效；连接模式需要更新私有 URL 文件并重新启动终端。主机插件可能新增仅面向浏览器的 UI 功能，这些功能需要终端呈现器才能在此使用。
