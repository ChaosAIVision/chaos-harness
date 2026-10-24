/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { assertAllowedModelRoutes, modelRouteKey, type AllowedModelRoute } from './model-selection.ts'

/** What caused one policy entry: the Session's first authorization, or a human-approved widening. */
export type PolicyOrigin = 'session-start' | 'setup'

/** Routes in force for one Session and how many accepted entries produced them. */
export interface SessionRoutePolicy {
  /** 1 for the first accepted entry (session start, legacy entry, or a first widening); +1 per accepted widening. */
  readonly revision: number
  /** Exact routes this Session may select explicitly for a child. */
  readonly routes: readonly AllowedModelRoute[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records this Session’s authorized child provider/model routes. The first
     * entry is appended before the first model request; a later entry with
     * `origin: 'setup'` and `revision` one above the current revision, whose routes
     * contain every current route, widens the set after a human approval. Any other
     * later entry is ignored on replay. Absence restricts explicit selection to the
     * current parent route. Log-only: it carries no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-policy': {
      /** Exact routes this Session may select explicitly for a child. */
      allowedModels: AllowedModelRoute[]
      /** Entry cause; absent in logs written before widening existed, read as `session-start`. */
      origin?: PolicyOrigin
      /** Revision this entry establishes; absent in older logs, read as 1. */
      revision?: number
    }
  }
}

const routeSchema = zod.object({ provider: zod.string().min(1), model: zod.string().min(1) }).strict()

const modelSelectionPolicySchema: zod.ZodType<SessionRoutePolicy | null> = zod.object({
  revision: zod.number().int().positive(),
  routes: zod.array(routeSchema).min(1),
}).strict().nullable()

/**
 * Routes of `want` that `have` does not contain.
 * @param have - routes already authorized.
 * @param want - routes that should be authorized.
 * @returns detached copies of the missing routes, in `want` order.
 */
export function missingRoutes(have: readonly AllowedModelRoute[], want: readonly AllowedModelRoute[]): AllowedModelRoute[] {
  const keys = new Set(have.map(modelRouteKey))
  return want.filter(route => !keys.has(modelRouteKey(route))).map(route => ({ ...route }))
}

/**
 * Union of two route lists with no duplicates.
 * @param have - routes kept first, in order.
 * @param want - routes appended when absent from `have`.
 * @returns detached copies containing every route of both lists.
 */
export function mergeRoutes(have: readonly AllowedModelRoute[], want: readonly AllowedModelRoute[]): AllowedModelRoute[] {
  return [...have.map(route => ({ ...route })), ...missingRoutes(have, want)]
}

function containsAll(next: readonly AllowedModelRoute[], current: readonly AllowedModelRoute[]): boolean {
  return missingRoutes(next, current).length === 0
}

/**
 * Whether a later entry carries a valid route list; a bad one is skipped so replay cannot be bricked.
 * @param routes - candidate route list from a logged entry.
 * @returns true when `assertAllowedModelRoutes` accepts it.
 */
function wellFormed(routes: unknown): boolean {
  try {
    assertAllowedModelRoutes(routes)
    return true
  } catch {
    return false
  }
}

/**
 * Host-only projection of the durable model-selection policy.
 * Each independently mounted consumer registers this shared definition; the registry reference-counts it.
 * Replay is monotone: after the first entry only a revision-successive superset from `setup` is accepted,
 * so no log content can narrow or replace the authorized set.
 */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionPolicy',
  stateVersion: 2,
  stateSchema: modelSelectionPolicySchema,
  init: () => null,
  apply: (policy, event) => {
    if (event.type !== 'subagent/model-selection-policy') return policy
    const { allowedModels, origin, revision } = event.data
    if (policy === null) {
      assertAllowedModelRoutes(allowedModels)
      if (allowedModels.length === 0) {
        throw new Error('subagent/model-selection-policy requires at least one route')
      }
      if (revision !== undefined && !(Number.isInteger(revision) && revision > 0)) {
        throw new Error('subagent/model-selection-policy requires a positive integer revision')
      }
      return { revision: revision ?? 1, routes: allowedModels }
    }
    if (origin !== 'setup' || revision !== policy.revision + 1 || !wellFormed(allowedModels)) return policy
    return containsAll(allowedModels, policy.routes) ? { revision, routes: allowedModels } : policy
  },
} satisfies ProjectionDefinition<'subagentModelSelectionPolicy', SessionRoutePolicy | null>

/**
 * Read the revision and exact route list authorized for a Session.
 * @param subagentModelSelectionProjectionHandle - registered policy state reader.
 * @param session - session whose durable decision is read.
 * @returns a detached policy, or undefined to restrict selection to the parent route.
 */
export function sessionPolicy(
  subagentModelSelectionProjectionHandle: Pick<ProjectionHandle<SessionRoutePolicy | null>, 'stateOf'>,
  session: Session,
): SessionRoutePolicy | undefined {
  const state = subagentModelSelectionProjectionHandle.stateOf(session)
  return state === null ? undefined : { revision: state.revision, routes: state.routes.map(route => ({ ...route })) }
}
