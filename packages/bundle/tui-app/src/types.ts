/** Terminal-owned presentation values. Domain state stays in the existing Client services. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionFace, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Initial navigation selected by the supported profile's command line. */
export type TerminalInitialView =
  | { readonly kind: 'new'; readonly preset?: string }
  | { readonly kind: 'picker' }
  | { readonly kind: 'session'; readonly sessionId: SessionId }

/** Resolved inputs for one terminal application lifetime. */
export interface TerminalAppOptions {
  readonly cwd: string
  readonly initial: TerminalInitialView
  readonly signal: AbortSignal
}

/** One typed selection row. The value is independent of translated labels. */
export interface TerminalChoice<T> {
  readonly label: string
  readonly description?: string
  readonly value: T
}

/** Keyboard views shared by the conversation and feature presenters. */
export interface TerminalPresentation {
  /** Show a selector until selection, cancellation or application shutdown. */
  choose<T>(title: string, choices: readonly TerminalChoice<T>[]): Promise<T | undefined>
  /** Read a value, returning undefined when the user cancels. Secrets must be masked. */
  input(title: string, options?: { readonly initial?: string; readonly secret?: boolean }): Promise<string | undefined>
  /** Show navigable content inside the terminal until the user returns. */
  show(title: string, text: string): Promise<void>
}

/** Feature access to existing Client operations and terminal-local navigation. */
export interface TerminalFeatureHost {
  readonly client: Context
  readonly view: TerminalPresentation
  readonly signal: AbortSignal
  /** Borrow the currently retained Session without changing its lifetime. */
  current(): SessionFace | undefined
  /** Retain the target and release the previous selection after successful opening. */
  select(target: SessionTarget): Promise<void>
}

/** A terminal presentation contribution included in slash completion. */
export interface TerminalFeatureCommand {
  readonly name: string
  readonly description: string
}
