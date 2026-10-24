/** Proof that a person confirmed an exact set of child routes. */

import { modelRouteKey } from './model-selection.ts'
import type { AllowedModelRoute } from './model-selection.ts'

declare const humanApproval: unique symbol

class Approval {
  declare readonly [humanApproval]: true

  constructor(readonly routes: readonly AllowedModelRoute[]) {}
}

/**
 * A person's confirmation, in this call, of exactly these routes. Persisted route authorization
 * and Session widening accept no other input, so model-supplied JSON or a file edit cannot stand in for it.
 * Only {@link mintHumanApproval} constructs one; an object literal does not satisfy the type.
 */
export type HumanApproval = Approval

/**
 * Record that a person answered a host-rendered question affirmatively. Call only from the adapter
 * that asked the person, after reading an exact affirmative answer.
 * @param routes - routes shown in the question.
 * @returns the proof for those routes.
 */
export function mintHumanApproval(routes: readonly AllowedModelRoute[]): HumanApproval {
  return new Approval(routes.map(route => ({ provider: route.provider, model: route.model })))
}

/**
 * Whether an approval covers every route.
 * @param approval - proof to check.
 * @param routes - routes that must be confirmed.
 * @returns true when no route is missing from the proof.
 */
export function approvalCovers(approval: HumanApproval, routes: readonly AllowedModelRoute[]): boolean {
  const confirmed = new Set(approval.routes.map(modelRouteKey))
  return routes.every(route => confirmed.has(modelRouteKey(route)))
}
