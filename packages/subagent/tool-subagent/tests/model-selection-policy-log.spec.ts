/** Replay rules of the widening model-selection policy log. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AllowedModelRoute } from '../src/model-selection.ts'
import {
  sessionPolicy,
  subagentModelSelectionProjectionDefinition as definition,
} from '../src/model-selection-state.ts'
import { ownContext } from './harness.ts'

const A: AllowedModelRoute = { provider: 'alpha', model: 'fast-model' }
const B: AllowedModelRoute = { provider: 'beta', model: 'big-model' }
const C: AllowedModelRoute = { provider: 'gamma', model: 'huge-model' }

async function projection() {
  const ctx = ownContext(new Context())
  await mountAgentLoopTestDependencies(ctx)
  return { ctx, handle: await ctx.sessionProjections.register(definition) }
}

function widen(session: Session, routes: AllowedModelRoute[], revision: number, origin: 'setup' | 'session-start' = 'setup'): void {
  session.append('subagent/model-selection-policy', { allowedModels: routes, origin, revision })
}

describe('model-selection policy projection', () => {
  it('reads a legacy entry without origin or revision as revision 1', async () => {
    const { handle } = await projection()
    const session = Session.create(SessionId('legacy'))
    session.append('subagent/model-selection-policy', { allowedModels: [A] })
    expect(sessionPolicy(handle, session)).toEqual({ revision: 1, routes: [A] })
    expect(sessionPolicy(handle, session)?.routes).toEqual([A])
  })

  it('accepts a successive superset from setup and exposes the latest', async () => {
    const { handle } = await projection()
    const session = Session.create(SessionId('widened'))
    session.append('subagent/model-selection-policy', { allowedModels: [A], origin: 'session-start', revision: 1 })
    widen(session, [A, B], 2)
    widen(session, [B, A, C], 3)
    expect(sessionPolicy(handle, session)).toEqual({ revision: 3, routes: [B, A, C] })
  })

  it('accepts a setup entry as the first entry of a session that began without a policy', async () => {
    const { handle } = await projection()
    const session = Session.create(SessionId('policy-less'))
    expect(sessionPolicy(handle, session)).toBeUndefined()
    widen(session, [A], 1)
    expect(sessionPolicy(handle, session)).toEqual({ revision: 1, routes: [A] })
    widen(session, [A, B], 2)
    expect(sessionPolicy(handle, session)?.revision).toBe(2)
  })

  it.each([
    ['narrows the set', [B], 2, 'setup'],
    ['replaces the set', [B, C], 2, 'setup'],
    ['skips a revision', [A, B], 3, 'setup'],
    ['repeats the revision', [A, B], 1, 'setup'],
    ['claims session-start origin', [A, B], 2, 'session-start'],
    ['carries a duplicate route', [A, A, B], 2, 'setup'],
  ] as const)('ignores a later entry that %s', async (_name, routes, revision, origin) => {
    const { handle } = await projection()
    const session = Session.create(SessionId('ignored'))
    session.append('subagent/model-selection-policy', { allowedModels: [A] })
    widen(session, [...routes], revision, origin)
    expect(sessionPolicy(handle, session)).toEqual({ revision: 1, routes: [A] })
  })

  it('ignores a later entry without revision or origin, as legacy first-wins logs required', async () => {
    const { handle } = await projection()
    const session = Session.create(SessionId('legacy-second'))
    session.append('subagent/model-selection-policy', { allowedModels: [A] })
    session.append('subagent/model-selection-policy', { allowedModels: [A, B] })
    expect(sessionPolicy(handle, session)).toEqual({ revision: 1, routes: [A] })
  })

  it('rejects an invalid first entry', async () => {
    const { handle } = await projection()
    const empty = Session.create(SessionId('empty'))
    empty.append('subagent/model-selection-policy', { allowedModels: [] })
    expect(() => sessionPolicy(handle, empty)).toThrow('requires at least one route')
    const badRevision = Session.create(SessionId('bad-revision'))
    badRevision.append('subagent/model-selection-policy', { allowedModels: [A], revision: 0 })
    expect(() => sessionPolicy(handle, badRevision)).toThrow('positive integer revision')
  })

  it('returns a detached copy', async () => {
    const { handle } = await projection()
    const session = Session.create(SessionId('detached'))
    session.append('subagent/model-selection-policy', { allowedModels: [A] })
    const read = sessionPolicy(handle, session)!
    ;(read.routes as AllowedModelRoute[]).push(B)
    expect(sessionPolicy(handle, session)?.routes).toEqual([A])
  })

  describe('replay from the stored log', () => {
    async function widenedSession() {
      const { ctx, handle } = await projection()
      const session = Session.create(SessionId('stored'))
      session.append('subagent/model-selection-policy', { allowedModels: [A] })
      widen(session, [A, B], 2)
      widen(session, [A, B, C], 3)
      return { ctx, handle, session }
    }

    it('refolds the full log when the checkpoint row predates stateVersion 2', async () => {
      const { ctx, session } = await widenedSession()
      const v1Row = { subagentModelSelectionPolicy: { ver: 1, seq: SessionSeq(0), val: [A] } }
      const restored = ctx.sessionProjections.restore(
        v1Row, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount,
      )
      expect(restored.checkpoint['subagentModelSelectionPolicy']).toMatchObject({
        ver: 2, val: { revision: 3, routes: [A, B, C] },
      })
    })

    it('refuses a partial tail over a version-1 row instead of serving it', async () => {
      const { ctx, session } = await widenedSession()
      expect(() => ctx.sessionProjections.restore(
        { subagentModelSelectionPolicy: { ver: 1, seq: SessionSeq(0), val: [A] } },
        session.snapshotEvents().slice(1), SessionLogOffset(1), session.header, session.inheritedEventCount,
      )).toThrow('re-read from seq 0')
    })

    it('matches full replay when a version-2 checkpoint is extended by its suffix', async () => {
      const { ctx, session } = await widenedSession()
      const events = session.snapshotEvents()
      const prefix = ctx.sessionProjections.restore(
        {}, events.slice(0, 2), SessionLogOffset(0), session.header, session.inheritedEventCount,
      )
      const resumed = ctx.sessionProjections.restore(
        prefix.checkpoint, events.slice(1), SessionLogOffset(1), session.header, session.inheritedEventCount,
      )
      const full = ctx.sessionProjections.restore(
        {}, events, SessionLogOffset(0), session.header, session.inheritedEventCount,
      )
      expect(resumed.checkpoint['subagentModelSelectionPolicy']).toEqual(full.checkpoint['subagentModelSelectionPolicy'])
      expect(full.checkpoint['subagentModelSelectionPolicy']?.val).toEqual({ revision: 3, routes: [A, B, C] })
    })
  })
})
