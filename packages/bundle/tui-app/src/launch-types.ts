/** Values crossing the independently compiled Host and terminal Client. */
export interface TerminalLaunch {
  readonly cwd: string
  readonly initial: { readonly kind: 'new'; readonly preset?: string }
    | { readonly kind: 'picker' }
    | { readonly kind: 'session'; readonly sessionId: string }
  readonly host: { readonly kind: 'owned'; readonly profile: string }
    | { readonly kind: 'attached'; readonly connectUrlFile: string }
}

/** Private Node Client entry, loaded after the Host launcher has parsed its flags. */
export interface TerminalClientEntry {
  run(connectUrl: string, launch: TerminalLaunch, signal: AbortSignal): Promise<void>
}
