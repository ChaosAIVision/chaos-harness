/** Host-owned opt-in setting for model-selectable subagent delegation. */
import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { approvalCovers, assertHumanApproval } from './human-approval.ts'
import type { HumanApproval } from './human-approval.ts'
import {
  sessionPolicy,
  subagentModelSelectionProjectionDefinition,
} from './model-selection-state.ts'
import type { SessionRoutePolicy } from './model-selection-state.ts'
import {
  AllowedModelRouteSchema,
  assertAllowedModelRoutes,
  type AllowedModelRoute,
  modelRouteKey,
} from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled during Agent creation, and the single writer of widening entries. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** Stored user preference; the shipped composition defaults it off. */
export interface SubagentModelSelectionSettings {
  /** Whether new top-level Sessions receive model selection. */
  enabled: boolean
  /** Exact child LLM routes offered to new top-level Sessions. */
  allowedModels: AllowedModelRoute[]
}

/** Trusted host callback sampled only when authorizing a fresh top-level Session. */
export type AllowedModelsSource = () => readonly AllowedModelRoute[] | undefined
  | Promise<readonly AllowedModelRoute[] | undefined>

/** How a {@link SubagentModelSelectionConfig.widenSession} request ended. */
export type WidenSessionOutcome =
  | { readonly kind: 'unchanged'; readonly revision: number | undefined }
  | { readonly kind: 'widened'; readonly revision: number }
  | { readonly kind: 'declined' }

/** Host-owned steps of one widening, run in this order and never reordered by the service. */
export interface WidenSessionSteps {
  /** Routes the caller still has to persist for future Sessions; they are confirmed together with the Session's missing routes. */
  readonly unsaved: readonly AllowedModelRoute[]
  /**
   * Ask the person about exactly these routes with host-rendered wording.
   * @param routes - routes to show.
   * @returns the proof after an exact affirmative answer, or undefined when declined, cancelled, or unavailable.
   */
  readonly ask: (routes: readonly AllowedModelRoute[]) => Promise<HumanApproval | undefined>
  /**
   * Durably save the caller's preferences, with the proof when routes were confirmed.
   * @param approval - proof for the confirmed routes; undefined when nothing needed confirming.
   * @returns when the save is committed; a rejection appends nothing.
   */
  readonly persist: (approval: HumanApproval | undefined) => Promise<void>
}

/** Optional deployment base for the preference. */
export interface Config {
  /** Explicit booleans select settings only; null defers to registered host sources. */
  enabled: Volatile<boolean | null>
  /** Initial route list inherited when the user document does not override it. */
  allowedModels: Volatile<AllowedModelRoute[]>
}

/** Host settings owner that records Session authorization before the first model request and widens it on approval. */
export class SubagentModelSelectionConfig extends Service {
  static inject = ['sessionProjections', 'sessions']

  static Config = z.object({
    enabled: z.union([z.boolean(), z.const(null)]).default(null).volatile(),
    allowedModels: z.array(AllowedModelRouteSchema).default([]).volatile(),
  })

  private readonly sources = new Set<AllowedModelsSource>()
  /** Set by `[Service.init]` before the service is published. */
  private policyHandle!: ProjectionHandle<SessionRoutePolicy | null>

  constructor(ctx: Context, private config: Config) {
    super(ctx, 'subagentModelSelection')
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const policyReady = ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    ctx.on('agent/created', async ({ agent }) => {
      const policy = await policyReady
      ctx.fiber.assertActive()
      const target = agent.session
      if (sessionPolicy(policy, target) !== undefined) return
      let allowedModels: AllowedModelRoute[] | undefined
      const parentId = target.header.origin === 'subagent' ? target.header.parentSession : undefined
      if (parentId !== undefined) {
        const parent = ctx.sessions.get(parentId)
        if (parent !== undefined) allowedModels = sessionPolicy(policy, parent)?.routes.map(route => ({ ...route }))
      } else if (target.firstLiveSeq === 0
        // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
        && target.eventAt(SessionSeq(0))?.type !== 'session/end-seed') {
        const current = await this.current()
        ctx.fiber.assertActive()
        allowedModels = current.enabled ? current.allowedModels : undefined
      }
      if (allowedModels !== undefined) target.append('subagent/model-selection-policy', { allowedModels })
    })
    this.policyHandle = await policyReady
  }

  /**
   * Register an operator-owned route source through the caller's effect lifecycle.
   * Sources are sampled only when a fresh Session starts and enabled is null; they never alter a recorded policy.
   * @param source - Callback returning authorized routes, or undefined when absent; failures reject Agent creation.
   * @returns Idempotent disposer that withdraws this registration.
   */
  registerAllowedModelsSource(source: AllowedModelsSource): () => void {
    const registered = () => source()
    this.sources.add(registered)
    return () => { this.sources.delete(registered) }
  }

  /**
   * Widen one running Session's authorized routes after a person confirms them, as one operation.
   * Order is fixed: ask, persist, append. A decline, an absent answer, a `persist` rejection, or an
   * abort appends nothing. Widening is monotone: the Session keeps every route it had and gains `routes`.
   * A Session without a policy keeps its parent route. Authorization is never derived from file contents, so
   * editing preferences outside this method grants nothing to a running Session.
   * @param agent - running Agent whose Session is widened.
   * @param routes - exact routes the Session should be allowed to select.
   * @param steps - host-owned ask and persist steps and the routes still to be saved.
   * @param signal - cancellation for the whole operation.
   * @returns `unchanged` when the Session already allows every route and `unsaved` is empty (persist still runs without a proof),
   *   `widened` with the new revision after an appended entry, or `declined` when no proof was given.
   * @throws when routes need confirmation while the operator setting is `enabled: false`, when a Session without a policy
   *   has no parent route, when
   *   the proof does not cover the missing routes, or when `persist` or the signal rejects.
   */
  async widenSession(
    agent: Agent,
    routes: readonly AllowedModelRoute[],
    steps: WidenSessionSteps,
    signal: AbortSignal,
  ): Promise<WidenSessionOutcome> {
    const handle = this.policyHandle
    assertAllowedModelRoutes(routes)
    const parentRoutes = (): AllowedModelRoute[] => {
      const { provider, model } = parentAgentOptionsForDelegation(agent)
      if (provider === undefined || model === undefined) {
        throw new Error('cannot widen a Session without a policy when its parent provider and model are unknown')
      }
      return [{ provider, model }]
    }
    const held = (): { revision: number | undefined; routes: readonly AllowedModelRoute[] } => {
      const current = sessionPolicy(handle, agent.session)
      return current ?? { revision: undefined, routes: parentRoutes() }
    }
    const missingFrom = (have: readonly AllowedModelRoute[]): AllowedModelRoute[] => {
      const keys = new Set(have.map(modelRouteKey))
      return routes.filter(route => !keys.has(modelRouteKey(route)))
    }
    const before = held()
    const missing = missingFrom(before.routes)
    const confirm = new Map<string, AllowedModelRoute>()
    for (const route of [...missing, ...steps.unsaved]) confirm.set(modelRouteKey(route), { ...route })
    if (confirm.size === 0) {
      await steps.persist(undefined)
      return { kind: 'unchanged', revision: before.revision }
    }
    if (this.config.enabled.get() === false) {
      throw new Error('subagent model selection is disabled by the operator setting; routes cannot be widened')
    }
    const approval = await steps.ask([...confirm.values()])
    if (approval === undefined) return { kind: 'declined' }
    assertHumanApproval(approval)
    if (!approvalCovers(approval, [...confirm.values()])) {
      throw new Error('the human approval does not cover every route that needs confirmation')
    }
    signal.throwIfAborted()
    await steps.persist(approval)
    signal.throwIfAborted()
    const after = held()
    if (missingFrom(after.routes).length === 0) return { kind: 'unchanged', revision: after.revision }
    const merged = new Map(after.routes.map(route => [modelRouteKey(route), route] as const))
    for (const route of routes) merged.set(modelRouteKey(route), { ...route })
    const revision = (after.revision ?? 0) + 1
    agent.session.append('subagent/model-selection-policy', {
      allowedModels: [...merged.values()], origin: 'setup', revision,
    })
    return { kind: 'widened', revision }
  }

  /**
   * Read a detached selection preference for the next fresh top-level Session.
   * @returns the enabled state and exact allowed routes.
   */
  private async current(): Promise<SubagentModelSelectionSettings> {
    const enabled = this.config.enabled.get()
    const allowedModels = this.config.allowedModels.get()
    assertAllowedModelRoutes(allowedModels)
    if (enabled === false) return { enabled: false, allowedModels: [] }
    if (enabled === true) {
      if (allowedModels.length === 0) {
        throw new Error('enabled subagent model selection requires at least one allowed model')
      }
      return { enabled: true, allowedModels: allowedModels.map(route => ({ ...route })) }
    }
    const routes = new Map<string, AllowedModelRoute>()
    for (const source of [...this.sources]) {
      const supplied = await source()
      if (supplied === undefined) continue
      assertAllowedModelRoutes(supplied)
      for (const route of supplied) routes.set(modelRouteKey(route), { ...route })
    }
    return { enabled: routes.size > 0, allowedModels: [...routes.values()] }
  }

}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
