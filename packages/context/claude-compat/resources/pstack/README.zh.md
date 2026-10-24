# pstack

[English](README.md) | 中文

Lauren Tan 的 [pstack](https://github.com/cursor/plugins/tree/main/pstack) 是一组具有明确工作方式的 skill（技能），用于改善 agent（智能体）的工作结果。这是面向 Claude Code、Codex 和其他 agent harness（智能体框架）的移植版本：skill 相同，Cursor 的操作方式则映射为各运行时的工具。

将目标告诉 `poteto-mode`，它就会调用合适的工作流：复现并查明缺陷根因，通过 `architect` 设计方案，在 `arena` 中比较候选方案，通过 `interrogate` 审查差异，或用 `unslop` 精简文字。它保持代码简洁、简单且经过验证，并报告实际执行的检查。

## 包含内容

- Skill：供 agent 阅读的 Markdown 指令。公开的 skill 以 `/pstack:<name>` 斜杠命令呈现。
- Agent：`pstack:poteto-agent`、`pstack:comment-sicko`，以及每个推理强度级别对应的 agent。
- SessionStart 钩子：注入 poteto-mode 路由指令，除非 `pstack-models.md` 配置表将其关闭。
- Pi 扩展：当仓库作为 Pi 包安装时，提供 subagent、提问和唤醒工具、`/loop`，以及相同的路由指令。
- 本地脚本：用于监控和交付 PR（Pull Request）、编排多阶段计划以及审计 worktree。

## 数据处理

pstack 没有服务器，也不收集遥测数据。Skill 要求 agent 阅读的任何内容，包括会话 transcript（文本记录），都会发送给模型提供方。脚本在本地运行，PR 工具使用 GitHub CLI（命令行界面）的登录身份。

## 链接

- [Skill、斜杠命令、运行时设置与模型配置](https://github.com/michael-denyer/pstack-claude/blob/main/docs/reference.md)
- [问题与支持](https://github.com/michael-denyer/pstack-claude/issues)
- [安全策略](https://github.com/michael-denyer/pstack-claude/blob/main/SECURITY.md)

## 许可证

本移植版本及其新增内容采用 MIT 许可证，© 2026 Michael Denyer。原始 pstack © 2026 Lauren Tan；导入的 cursor-team-kit skill © 2026 Cursor。参见 [NOTICE.md](https://github.com/michael-denyer/pstack-claude/blob/main/NOTICE.md)。
