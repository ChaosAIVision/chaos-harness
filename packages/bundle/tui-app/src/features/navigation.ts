/** Workspace, session and direct-parent subagent navigation. */
import { z } from 'zod'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { TerminalFeatureHost } from '../types.ts'
import { accepted, confirm, details, receipt, selected } from './common.ts'
import { featureText as t } from './locales.ts'

/** Open or manage a Host-owned session without taking over its lifecycle.
 * @param host - Current terminal services.
 */
export async function sessions(host: TerminalFeatureHost): Promise<void> {
  await host.client.sessions.refresh()
  const catalog = host.client.sessions.list.getSnapshot()
  const row = await host.view.choose<{ kind: 'new' } | { kind: 'search' } | { kind: 'session'; id: typeof catalog.ids[number] }>(t.sessions, [
    { label: t.newSession, value: { kind: 'new' as const } },
    { label: t.search, value: { kind: 'search' as const } },
    ...catalog.ids.map(id => ({ label: catalog.byId[id]?.displayTitle ?? id, description: id, value: { kind: 'session' as const, id } })),
  ])
  if (row === undefined) return
  if (row.kind === 'new') {
    const cwd = await host.view.input(t.cwd)
    if (cwd === undefined) return
    const preset = await host.view.input(t.preset)
    if (preset === undefined) return
    await host.select(await host.client.sessions.create({ ...cwd.trim() === '' ? {} : { cwd }, ...preset.trim() === '' ? {} : { agentPreset: preset } }))
    return
  }
  if (row.kind === 'search') {
    const query = await host.view.input(t.searchText)
    if (query === undefined) return
    const result = accepted(await host.client.sessions.search(query, host.signal))
    const target = await host.view.choose(t.sessions, result.items.map(item => ({
      label: item.snippet, description: item.sessionId, value: item.sessionId,
    })))
    if (target !== undefined) await host.select(target)
    return
  }
  if (!('id' in row)) return
  const sessionId = row.id
  const action = await host.view.choose(t.sessions, [
    { label: t.open, value: 'open' }, { label: t.rename, value: 'rename' }, { label: t.fork, value: 'fork' },
    { label: t.archive, value: 'archive' }, { label: t.restore, value: 'restore' },
    { label: t.pin, value: 'pin' }, { label: t.unpin, value: 'unpin' },
  ])
  if (action === 'open') await host.select(sessionId)
  if (action === 'rename') {
    const title = await host.view.input(t.title, { initial: catalog.byId[sessionId]?.title ?? '' })
    if (title !== undefined) await receipt(host, await host.client.remote.session.rename({ sessionId, title }))
  }
  if (action === 'fork') await host.select(await host.client.sessions.fork({ sessionId, increaseTitle: true }))
  if (action === 'archive' && await confirm(host, t.archive)) await receipt(host, await host.client.remote.workspace.archiveSession({ sessionId }))
  if (action === 'restore') await receipt(host, await host.client.remote.workspace.unarchiveSession({ sessionId }))
  if (action === 'pin') await receipt(host, await host.client.remote.workspace.pinSession({ sessionId }))
  if (action === 'unpin') await receipt(host, await host.client.remote.workspace.unpinSession({ sessionId }))
}

/** Register, rename, remove, reorder and open workspaces and their sessions.
 * @param host - Current terminal services.
 */
export async function workspaces(host: TerminalFeatureHost): Promise<void> {
  const stream = host.client.remote.workspace.follow(host.signal)
  try {
    for await (const frame of stream) {
      if (frame.type !== 'baseline') continue
      const item = await host.view.choose<{ kind: 'new' } | { kind: 'existing'; workspace: typeof frame.value.items[number] }>(t.workspaces, [
        { label: t.workspaceCreate, value: { kind: 'new' as const } },
        ...frame.value.items.map(workspace => ({ label: workspace.title, description: workspace.path, value: { kind: 'existing' as const, workspace } })),
      ])
      if (item === undefined) return
      if (!('workspace' in item)) {
        const path = await host.view.input(t.path)
        if (path !== undefined) await receipt(host, await host.client.remote.workspace.create({ path }))
        return
      }
      const workspace = item.workspace
      const action = await host.view.choose(workspace.title, [
        { label: t.newSession, value: 'new' }, { label: t.sessions, value: 'sessions' },
        { label: t.workspaceRename, value: 'rename' }, { label: t.workspaceRemove, value: 'delete' },
        { label: t.reorderWorkspace, value: 'reorder' }, { label: t.reorderSessions, value: 'reorderSessions' },
      ])
      if (action === 'new') await host.select(await host.client.sessions.create({ workspaceId: workspace.workspaceId }))
      if (action === 'sessions') {
        await host.client.sessions.refresh()
        const rows = host.client.sessions.list.getSnapshot().byId
        const id = await host.view.choose(t.sessions, workspace.sessionIds.map(id => ({ label: rows[id]?.displayTitle ?? id, value: id })))
        if (id !== undefined) await host.select(id)
      }
      if (action === 'rename') {
        const title = await host.view.input(t.title, { initial: workspace.title })
        if (title !== undefined) {
          await receipt(host, await host.client.remote.workspace.rename({ workspaceId: workspace.workspaceId, title }))
        }
      }
      if (action === 'reorder') {
        const anchor = await host.view.choose<{ kind: 'end' } | { kind: 'before'; id: typeof workspace.workspaceId }>(t.moveBefore, [
          ...frame.value.items.filter(candidate => candidate.workspaceId !== workspace.workspaceId).map(candidate => ({ label: candidate.title, value: { kind: 'before' as const, id: candidate.workspaceId } })),
          { label: t.moveToEnd, value: { kind: 'end' as const } },
        ])
        if (anchor !== undefined) await receipt(host, await host.client.remote.workspace.insertBefore({ workspaceId: workspace.workspaceId, ...anchor.kind === 'before' ? { beforeWorkspaceId: anchor.id } : {} }))
      }
      if (action === 'reorderSessions') {
        await host.client.sessions.refresh()
        const rows = host.client.sessions.list.getSnapshot().byId
        const sessionId = await host.view.choose(t.sessions, workspace.sessionIds.map(id => ({
          label: rows[id]?.displayTitle ?? id, value: id,
        })))
        if (sessionId === undefined) return
        const anchor = await host.view.choose<{ kind: 'end' } | { kind: 'before'; id: typeof sessionId }>(t.moveBefore, [
          ...workspace.sessionIds.filter(id => id !== sessionId).map(id => ({ label: rows[id]?.displayTitle ?? id, value: { kind: 'before' as const, id } })),
          { label: t.moveToEnd, value: { kind: 'end' as const } },
        ])
        if (anchor !== undefined) await receipt(host, await host.client.remote.workspace.insertSessionBefore({ workspaceId: workspace.workspaceId, sessionId, ...anchor.kind === 'before' ? { beforeSessionId: anchor.id } : {} }))
      }
      if (action === 'delete' && await confirm(host, `${t.workspaceRemove}: ${workspace.title}`)) {
        await receipt(host, await host.client.remote.workspace.delete({ workspaceId: workspace.workspaceId }))
      }
      return
    }
  } finally { stream.dispose() }
}

/** Browse descendants through authoritative direct-child projections and addresses.
 * @param host - Current terminal services.
 * @param parent - Optional parent address for recursive browsing.
 */
export async function subagents(host: TerminalFeatureHost, parent = selected(host).sessionId): Promise<void> {
  const projection = accepted(await host.client.remote.session.projections({ sessionId: parent }, host.signal))
  const children = projection?.values.subagentCatalog
  if (children === undefined) throw new Error(t.unavailable)
  const child = await host.view.choose(t.subagents, children.map(child => ({
    label: child.label ?? child.id, description: child.mode, value: child,
  })))
  if (child === undefined) return
  const action = await host.view.choose(child.label ?? child.id, [
    { label: t.open, value: 'open' }, { label: t.subagents, value: 'children' },
    ...child.mode === 'continuable' ? [{ label: t.followup, value: 'followup' }, { label: t.steer, value: 'steer' }] : [],
    ...child.mode === 'continuable' ? [{ label: t.stop, value: 'stop' }] : [],
  ])
  if (action === 'children') { await subagents(host, child.id); return }
  if (child.mode === 'external') { await host.view.show(t.subagents, details(child)); return }
  const address: SubagentAddress = { parentSessionId: parent, childSessionId: child.id, mode: child.mode }
  if (action === 'open') await host.select(address)
  if (action === 'stop' && child.mode === 'continuable') await receipt(host, await host.client.remote.subagents.interruptByParent(child.id, parent, 'continuable'))
  if ((action === 'followup' || action === 'steer') && child.mode === 'continuable') {
    const text = await host.view.input(t.prompt)
    if (text === undefined) return
    await host.client.sessions.using(address, { source: 'controllerOperation', signal: host.signal }, async (reference) => {
      const { session } = await reference.ready
      const mode = action === 'steer' ? 'steer' : 'queue'
      const submission = session.beginSubmission({ text, mode, attachments: [] })
      try { accepted(await session.prompt([{ type: 'text', text }], mode, host.signal, submission.requestId)) }
      catch (error) { submission.abandon(); throw error }
    })
  }
}

const pendingMessage = z.object({ id: z.string().min(1).transform(MessageId), content: z.array(z.unknown()) }).passthrough()

/** Edit, remove, or steer a still-pending inbox occurrence.
 * @param host - Current terminal services.
 */
export async function queue(host: TerminalFeatureHost): Promise<void> {
  const session = selected(host)
  const projection = accepted(await host.client.remote.session.projections({ sessionId: session.sessionId }, host.signal))
  const inbox = projection?.values.inbox
  if (inbox === undefined) throw new Error(t.unavailable)
  const messages = [...inbox['next-turn'], ...inbox['next-step']].map(item => pendingMessage.parse(item))
  const message = await host.view.choose(t.queue, messages.map(message => ({
    label: details(message.content), description: message.id, value: message,
  })))
  if (message === undefined) return
  const action = await host.view.choose(t.queue, [{ label: t.editQueue, value: 'edit' }, { label: t.remove, value: 'remove' }, { label: t.steer, value: 'steer' }])
  if (action === 'remove' || action === 'steer') await receipt(host, await session.updateQueue(message.id, { kind: action }))
  if (action === 'edit') {
    const text = await host.view.input(t.prompt)
    if (text !== undefined) await receipt(host, await session.updateQueue(message.id, { kind: 'edit' as const, content: [{ type: 'text', text }] }))
  }
}

/** Inspect the retained event window, loading older pages on demand.
 * @param host - Current terminal services.
 */
export async function trajectory(host: TerminalFeatureHost): Promise<void> {
  const session = selected(host)
  const binding = host.client.sessions.binding(session.sessionId)
  if (binding === undefined) throw new Error(t.noSession)
  while (!host.signal.aborted) {
    const window = binding.eventSource.getSnapshot()
    const action = await host.view.choose<{ kind: 'older' } | { kind: 'event'; event: typeof window.entries[number]['event'] }>(t.trajectory, [
      ...window.hasMore ? [{ label: t.loadOlder, value: { kind: 'older' as const } }] : [],
      ...window.entries.map(entry => ({ label: `${entry.event.seq}  ${entry.event.type}`, description: new Date(entry.event.time).toISOString(), value: { kind: 'event' as const, event: entry.event } })),
    ])
    if (action === undefined) return
    if ('event' in action) await host.view.show(`${action.event.seq}  ${action.event.type}`, details(action.event))
    else await session.loadOlder()
  }
}
