/** Live command and skill discovery from generated Remote results. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { TerminalCatalog } from '../src/catalog.ts'

describe('terminal slash catalog', () => {
  it('merges Host commands, user-invocable skills, and terminal actions with one execution owner', async () => {
    const client = new Context()
    let names = ['host-action']
    Object.defineProperty(client, 'remote', { value: {
      commands: { list: async () => ({ ok: true, value: [...names.map(name => ({ name, description: name })), { name: 'model', description: 'Host model' }] }) },
      skills: { list: async () => ({ ok: true, value: { skills: [{ name: 'review-code', description: 'Review', modelInvocable: false }] } }) },
    } })
    const catalog = new TerminalCatalog(client, [{ name: 'files', description: 'Browse files' }])
    expect(catalog.list().some(command => command.name === 'quit')).toBe(true)
    try {
      await catalog.refresh(SessionId('session'), new AbortController().signal)
      expect(catalog.list().find(command => command.name === 'host-action')?.kind).toBe('host')
      expect(catalog.list().find(command => command.name === 'review-code')?.kind).toBe('skill')
      expect(catalog.list().find(command => command.name === 'model')?.kind).toBe('terminal')
      expect(catalog.list().find(command => command.name === 'files')?.kind).toBe('terminal')
      names = ['new-host-action']
      const provider = catalog.provider(process.cwd(), new AbortController().signal, (error) => { throw error })
      const suggestions = await provider.getSuggestions(['/new-host'], 0, 9, { signal: new AbortController().signal })
      expect(suggestions?.items.some(item => item.value.includes('new-host-action'))).toBe(true)
      expect(catalog.list().some(command => command.name === 'host-action')).toBe(false)
    } finally { await client.fiber.dispose() }
  })

  it('ignores a late catalog response for a previously selected Session', async () => {
    const client = new Context()
    const older = Promise.withResolvers<Awaited<ReturnType<Context['remote']['commands']['list']>>>()
    Object.defineProperty(client, 'remote', { value: {
      commands: { list: async (id: string) => id === 'older' ? older.promise : { ok: true, value: [{ name: 'current', description: 'Current' }] } },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    } })
    const catalog = new TerminalCatalog(client, [])
    try {
      const first = catalog.refresh(SessionId('older'), new AbortController().signal)
      await catalog.refresh(SessionId('current'), new AbortController().signal)
      older.resolve({ ok: true, value: [{ name: 'obsolete', description: 'Obsolete' }] })
      await first
      expect(catalog.list().some(command => command.name === 'current')).toBe(true)
      expect(catalog.list().some(command => command.name === 'obsolete')).toBe(false)
    } finally { await client.fiber.dispose() }
  })
})
