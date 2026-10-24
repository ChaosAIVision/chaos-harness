/** Live slash discovery from Host commands, invocable skills, and terminal actions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AutocompleteProvider, SlashCommand } from '@earendil-works/pi-tui'
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui'
import { conversationText as t } from './conversation-locales.ts'
import type { TerminalFeatureCommand } from './types.ts'

/** A discovered command retains its execution owner. */
export interface TerminalCommand extends SlashCommand {
  readonly kind: 'terminal' | 'host' | 'skill'
}

/** Refreshable catalog owned by one terminal lifetime. */
export class TerminalCatalog {
  private commands: readonly TerminalCommand[] = []
  private generation = 0
  private sessionId: SessionId | undefined

  constructor(private readonly client: Context, private readonly features: readonly TerminalFeatureCommand[]) {
    this.commands = [...features.map(command => ({ ...command, kind: 'terminal' as const })),
      ...Object.entries(t.commands).map(([name, description]) => ({ name, description, kind: 'terminal' as const }))]
  }

  /** Read slash discovery. @returns the latest successful catalog, including terminal-local commands. */
  list(): readonly TerminalCommand[] { return this.commands }

  /**
   * Refresh without publishing a result for an obsolete selected Session.
   * @param sessionId - retained Session whose effective composition is queried.
   * @param signal - application lifetime.
   * @returns completion or the Remote failure.
   */
  async refresh(sessionId: SessionId, signal: AbortSignal): Promise<void> {
    this.sessionId = sessionId
    const generation = ++this.generation
    const [commands, skills] = await Promise.all([
      this.client.remote.commands.list(sessionId),
      this.client.remote.skills.list({ sessionId }, signal),
    ])
    if (!commands.ok) throw new Error(`${commands.error.code}: ${commands.error.message}`)
    if (!skills.ok) throw new Error(`${skills.error.code}: ${skills.error.message}`)
    if (generation !== this.generation || signal.aborted) return
    const catalog = new Map<string, TerminalCommand>()
    for (const skill of skills.value.skills) catalog.set(skill.name, { ...skill, kind: 'skill' })
    for (const command of commands.value) catalog.set(command.name, { ...command, kind: 'host' })
    for (const command of this.features) catalog.set(command.name, { ...command, kind: 'terminal' })
    for (const [name, description] of Object.entries(t.commands)) catalog.set(name, { name, description, kind: 'terminal' })
    this.commands = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Refresh at suggestion time so extensions and skill changes appear immediately.
   * @param cwd - path completion root.
   * @param signal - application lifetime.
   * @param failed - visible error reporter.
   * @returns Pi's editor autocomplete adapter.
   */
  provider(cwd: string, signal: AbortSignal, failed: (error: unknown) => void): AutocompleteProvider {
    const create = (): CombinedAutocompleteProvider => new CombinedAutocompleteProvider([...this.commands], cwd)
    return {
      triggerCharacters: ['/'],
      getSuggestions: async (lines, line, col, options) => {
        if (lines[line]?.startsWith('/') && this.sessionId !== undefined) {
          try { await this.refresh(this.sessionId, AbortSignal.any([signal, options.signal])) }
          catch (error) { if (!options.signal.aborted && !signal.aborted) failed(error) }
        }
        return create().getSuggestions(lines, line, col, options)
      },
      applyCompletion: (lines, line, col, item, prefix) => create().applyCompletion(lines, line, col, item, prefix),
    }
  }
}
