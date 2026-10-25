# Terminal recorded-session replay

English | [中文](README.zh.md)

After `pnpm run build:artifacts`, run `DSH_EXAMPLE_MODE=lib pnpm run test:snapshot -t 'tui resumes'`. The adapter requires Python 3 and a Unix PTY. Windows and source-only snapshot runs skip this adapter.

The scenario borrows the Web messages recording, materializes its identities into an isolated `DSH_HOME`, and starts the built `dsh tui --resume` profile without provider credentials. It checks the committed assistant text under the assistant heading, readiness, clean terminal exit, and preserved recorded history. Parsed terminal screens also verify hidden internal context, a model menu without underlying chat text, and conversation restoration after Escape. It accepts only an empty resume seed event and a startup-hook text insertion paired with its exact cancellation. Human prompts, other event types, and pending inbox work fail replay. It submits no new model turn. Only the owning Web scenario records or refreshes the shared Session.
