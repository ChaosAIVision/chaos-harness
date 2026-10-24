/** Persistent shell presentation using the existing Client terminal state owner. */
import { randomUUID } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-api-terminal-controller/client'
import type { WebTerminalInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { TerminalFeatureHost } from '../types.ts'
import { accepted, confirm, details, receipt, selected } from './common.ts'
import { featureText as t } from './locales.ts'

async function attach(host: TerminalFeatureHost, info?: WebTerminalInfo, shellPath?: string): Promise<void> {
  const sessionId = selected(host).sessionId
  const key = info?.id ?? randomUUID()
  const view = host.client.webTerminals.view(sessionId, key, key, info?.id, shellPath)
  await host.view.show(t.terminals, t.terminalExit)
  await host.view.terminal(info?.title ?? t.terminalCreate, async (lease) => {
    let revision = -1
    let resized = false
    let issue: string | undefined
    const render = (): void => {
      const state = view.state.getSnapshot()
      if (state.render !== undefined && state.render.revision !== revision) {
        revision = state.render.revision
        lease.write(state.render.frame.type === 'snapshot' ? `\x1b[2J\x1b[H${state.render.frame.screen}` : state.render.frame.data)
        view.acknowledge(revision)
      }
      if (state.writable && !resized) {
        resized = true
        const size = lease.size()
        view.resize(size.columns, size.rows)
      }
      const nextIssue = state.phase === 'failed' ? state.error ?? state.issue ?? t.error
        : state.phase === 'connected' && !state.writable ? t.terminalReadonly : undefined
      if (nextIssue !== undefined && issue !== nextIssue) lease.write(`\r\n${nextIssue}\r\n`)
      issue = nextIssue
    }
    const unsubscribe = view.state.subscribe(render)
    const unmount = view.mount()
    const input = lease.onInput(text => { view.write(text) })
    const resize = lease.onResize(size => { view.resize(size.columns, size.rows) })
    try {
      render()
      if (!lease.signal.aborted) await new Promise<void>(resolve => { lease.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    } finally {
      input()
      resize()
      unsubscribe()
      unmount()
      host.client.webTerminals.retainTabs([])
    }
  })
}

/** Create, attach, rename or explicitly close a persistent Host terminal.
 * @param host - Current terminal services.
 */
export async function terminals(host: TerminalFeatureHost): Promise<void> {
  const sessionId = selected(host).sessionId
  const terminals = accepted(await host.client.remote.terminal.list(sessionId))
  const choice = await host.view.choose<{ kind: 'new' } | { kind: 'existing'; terminal: typeof terminals[number] }>(t.terminals, [
    { label: t.terminalCreate, value: { kind: 'new' as const } },
    ...terminals.map(terminal => ({ label: `${terminal.title} [${terminal.state}]`, description: terminal.cwd, value: { kind: 'existing' as const, terminal } })),
  ])
  if (choice === undefined) return
  if (!('terminal' in choice)) {
    const shells = accepted(await host.client.remote.terminal.shells(sessionId, host.signal))
    const shell = await host.view.choose(t.terminalCreate, shells.map(shell => ({ label: shell.name, description: shell.path, value: shell })))
    if (shell !== undefined) await attach(host, undefined, shell.path)
    return
  }
  const terminal = choice.terminal
  const action = await host.view.choose(terminal.title, [
    { label: t.terminalAttach, value: 'attach' }, { label: t.details, value: 'details' },
    { label: t.terminalRename, value: 'rename' }, { label: t.terminalClose, value: 'close' },
  ])
  if (action === 'attach') await attach(host, terminal)
  if (action === 'details') await host.view.show(terminal.title, details(terminal))
  if (action === 'rename') {
    const title = await host.view.input(t.title, { initial: terminal.title })
    if (title !== undefined) await receipt(host, await host.client.remote.terminal.rename(sessionId, terminal.id, title))
  }
  if (action === 'close' && await confirm(host, `${t.terminalClose}: ${terminal.title}`)) {
    await receipt(host, await host.client.remote.terminal.close(sessionId, terminal.id))
  }
}
