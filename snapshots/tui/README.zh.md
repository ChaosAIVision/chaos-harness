# Terminal recorded-session replay

[English](README.md) | 中文

运行 `pnpm run build:artifacts` 后，执行 `DSH_EXAMPLE_MODE=lib pnpm run test:snapshot -t 'tui resumes'`。此适配器需要 Python 3 和 Unix PTY。Windows 和仅运行源码的快照测试会跳过此适配器。

此场景借用 Web 消息记录，在隔离的 `DSH_HOME` 中替换标识，并在没有提供方凭据的情况下启动构建后的 `dsh tui --resume` 配置。它检查助手标题下已提交的回复文本、就绪状态、正常退出，以及原有记录未被修改。解析后的终端画面还会验证内部上下文已隐藏、模型菜单不显示底层聊天文本，以及按 Escape 后恢复会话。记录后只允许追加空的恢复种子事件，以及与精确取消操作配对的启动钩子文本插入。用户提示、其他事件类型或仍待处理的收件箱内容都会使回放失败。此场景不提交新的模型轮次。只有拥有原始记录的 Web 场景可以重新录制或刷新共享 Session。
