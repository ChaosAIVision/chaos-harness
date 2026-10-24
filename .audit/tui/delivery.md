# Terminal UI delivery

Run `/Users/chaos/project/research/deepseek_cli/run-tui.sh` in Terminal.app. Add `--load` to choose an existing session or `--resume SESSION_ID` to reopen one. The launcher uses the built official `dsh tui` profile in the development worktree.

Source is `/Users/chaos/.local/share/chaos-harness-wt/terminal-ui`, branch `feature/terminal-ui`, source revision `cdfad909`. No push, merge, or installed runtime replacement was performed.

Internal runtime context is hidden from the default chat. Full recorded detail remains available through `/trajectory`.

The TUI uses Pi primitives and the existing Web Host and typed Client services. It includes streaming chat, load/resume/fork, dynamic Host commands and skills, scoped approvals and questions, pstack, settings/providers, jobs/schedules, workspaces, persistent shells, file/document navigation, image attachment, changes and exports. Colliding commands retain explicit `/host:NAME` and `/skill:NAME` access.

## Verification

- Final build passed all 10 artifact and aggregate compiler checks. `/tmp/dsh-tui-final-build-4.log`.
- Related tests passed 129 cases in 13 files. `/tmp/dsh-tui-final-tests-3.log`.
- Web subagent regression passed 12 cases. `/tmp/dsh-tui-web-regression.log`.
- Actual built CLI and PTY exercised chat, persisted resume, help/settings, direct questions and both pstack authorization outcomes. `/tmp/dsh-tui-final-pty-chat.log`, `/tmp/dsh-tui-final-pty-question.log`, `/tmp/dsh-tui-final-pty-pstack-approve.log`, `/tmp/dsh-tui-final-pty-pstack-decline.log`.
- Actual persistent shell produced `TUI_SHELL_OK`, returned to chat with Ctrl+], and reopened help. `/tmp/dsh-tui-final-pty-shell-2.log`.
- Independent final review found no remaining blocking correctness or security findings. `/Users/chaos/.local/share/chaos-harness-wt/terminal-ui/.audit/tui/independent-review.md`.
- JSDoc and Cordis configuration checks passed. The application-entrypoint check reports six existing vendored pstack scripts. Neither those scripts nor that check changed from the base commit.

PTY scenarios used isolated homes and a scripted local model endpoint. They do not establish real-provider quality or visual observation inside Terminal.app. Computer Use was not used again.

## Limits

Documents use terminal text/table/navigation views. Third-party browser-only plugin interfaces require terminal presenters. Tool/reasoning folds are global. Timed questions retain Host timing but do not expose Web countdown/pause controls. Retained history views require loading older history to include earlier deliverables. This is not a claim that every Web interaction has identical terminal controls.

The PTY driver and local mock are retained under the worktree `.audit/tui/` for reproduction. The committed `snapshots/tui/` adapter adds keyless recorded-session replay to the repository snapshot lane. It borrows the existing Web recording, verifies actual terminal assistant text/readiness and clean exit, and protects the recorded history from rewrites. The snapshot and corpus tests passed four cases in two files. `/tmp/dsh-tui-recorded-snapshot-lib-final.log`.

The built TUI replay runs with `DSH_EXAMPLE_MODE=lib`; the source-only snapshot lane skips this adapter. Its queue check permits only the observed startup-hook text insertion and its exact cancellation, with no pending work or human prompt.

## Model-menu visual correction

The user screenshot exposed conversation text around the centered overlay. The renderer now gives panels the full viewport and pads every row. Internal context rows are excluded from default chat rendering. Runtime source revision is `0e2f3df9`; recorded-screen test revision is `5fb5e4ac`.

The original actual-CLI screen assertion failed with `Model menu mixed with conversation` in `/tmp/dsh-tui-overlay-screen-before.log`. The same check now reports `PASS model menu has a clean screen` in `/tmp/dsh-tui-overlay-screen-after.log`. Real xterm screen tests cover resize, Escape restoration and retained drafts. Build passed10/10 in `/tmp/dsh-tui-overlay-build.log`, TUI tests passed65/65 in `/tmp/dsh-tui-overlay-tests.log`, and actual recorded PTY screen/corpus checks passed4/4 in `/tmp/dsh-tui-overlay-snapshot-green.log`.
