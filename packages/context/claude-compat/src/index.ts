/**
 * Compatibility shim for Claude Code plugin directories.
 *
 * Claude Code plugins carry capabilities Harness has no native equivalent for:
 * named subagent types (`subagent_type: "pstack:comment-sicko"`) declared as
 * `agents/*.md`, per-role model selection from a saved sheet, and
 * `hooks/hooks.json`. This plugin reads a configured list of plugin roots and
 * adds all three: `claude_agent` dispatches named and general-purpose agents
 * through `ctx.subagents`, `claude_agent_models` exposes policy-aware route and
 * effort discovery, and a mounted
 * `dsh-hooks-claude-code` bridge handles each root that has a hook config.
 *
 * @module @deepseek-ai/dsh-claude-compat
 */

import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { WorktreeService } from '@deepseek-ai/dsh-experimental-worktree'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import type { SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import {
  assertAllowedModelSelection,
  mintHumanApproval,
  preflightChildLlmRoute,
  sessionPolicy,
  subagentModelSelectionProjectionDefinition,
} from '@deepseek-ai/dsh-tool-subagent'
import type { HumanApproval, ModelSelectionPolicy, WidenSessionOutcome, WidenSessionSteps } from '@deepseek-ai/dsh-tool-subagent'
import * as hooksBridge from '@deepseek-ai/dsh-hooks-claude-code'
import * as filesystemSkills from '@deepseek-ai/dsh-skill-filesystem'
import { bundledPstackRoot } from './pstack-resources.ts'
export { bundledPstackRoot } from './pstack-resources.ts'
import { parse as parseYaml } from 'yaml'
import { assertSetupUpdate, loadPstackPreferences, savePstackPreferences } from './pstack-config.ts'
import { contextMessage, loadRoleSheet, renderRoleSheet } from './role-sheet.ts'
import type { RoleChoices, RoleSheet } from './role-sheet.ts'
export { loadPstackPreferences, parsePstackPreferences, pstackConfigPath, savePstackPreferences } from './pstack-config.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Runtime report of a delegate checkout retained for review. */
    'worktree-kept': { kind: 'worktree-kept' }
  }
}

export const name = 'experimental-claude-compat'

export const inject = ['tools', 'subagents', 'sessionProjections', 'skills']

/** One configured child LLM route. */
export interface RouteConfig {
  /** LLM provider id configured in the profile. */
  provider: string
  /** Model id dispatched through the configured provider. */
  model: string
  /** Reasoning effort id; omission uses the provider default. */
  reasoningEffort?: string
}

/** Claude plugin discovery, child routing, and initialization settings. */
export interface Config {
  /** Plugin roots to read, in priority order. `~` is expanded. */
  roots: string[]
  /** `ctx.subagents` provider used for every dispatch. */
  provider: string
  /**
   * Routes stored per subagent type. `"*"` supplies the fallback, and the
   * explicit `subagent_type` key wins. An unconfigured type inherits the
   * parent route.
   */
  models: Record<string, RouteConfig>
  /** Model-only routes overriding fresh home-scoped aliases; aliases do not grant Session authorization. */
  modelAliases: Record<string, RouteConfig>
  /** Native pstack initialization; replaces this root's bridged SessionStart. */
  pstack?: {
    /** Installed pstack plugin root containing `hooks/session-start-context.md`; `~` is expanded. */
    root: string
    /** Saved model-choice sheet read at agent initialization; `~` is expanded. */
    sheetPath: string
  } | undefined
  /** Allow raw provider/model overrides of standing routes; recorded Session authorization still applies. */
  modelSelection: boolean
  /** Mount a hook bridge for each root that has `hooks/hooks.json`. */
  hooks: boolean
  /** Working directory handed to hook commands; defaults to the session directory. */
  projectDir?: string
}

export const Config: z<Config> = z.object({
  roots: z.array(z.string()).default([]),
  provider: z.string().default('spawn'),
  models: z.dict(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  })).default({}),
  modelAliases: z.dict(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  })).default({}),
  pstack: (z.object({ root: z.string().required(), sheetPath: z.string().required() }) as z<Config['pstack']>).default(undefined),
  modelSelection: z.boolean().default(false),
  hooks: z.boolean().default(true),
  projectDir: z.string(),
})

/**
 * The seam the plugin actually needs, so compatibility logic is testable
 * without booting a profile. `apply` adapts a Cordis context to this shape.
 */
export interface CompatHost {
  /** Register one model-facing tool and return its disposer. */
  readonly registerTool: (tool: ToolDefinition) => () => void
  /** Start one child execution. */
  readonly startActivation: (spec: SubagentActivationSpec) => Promise<{ childId: string; result: Promise<unknown> }>
  /**
   * Optional worktree capability. Absence hides and rejects isolation; the adapter owns kept notices.
   * @param parent - caller whose directory and file policy select the source repository.
   * @param cwd - source directory relative to the parent; omission uses the parent directory.
   * @param start - dispatch the child in the service-selected directory.
   * @param signal - cancellation of provisioning, not settlement.
   * @returns activation and model-visible isolation or degradation description.
   */
  readonly isolateWorktree?: ((
    parent: Agent,
    cwd: string | undefined,
    start: (cwd: string) => ReturnType<CompatHost['startActivation']>,
    signal: AbortSignal,
  ) => Promise<{ activation: Awaited<ReturnType<CompatHost['startActivation']>>; description: string }>) | undefined
  /** Watch service addition, removal, and replacement; the host owns listener disposal. */
  readonly onWorktreeChange?: (refresh: () => void) => void
  /** LLM catalog, when the host mounts one. */
  readonly llm: (Pick<LlmRuntime, 'resolveCallConfig' | 'resolveModelInfo'> & Partial<Pick<LlmRuntime, 'listProviders' | 'listModels'>>) | undefined
  /** Recorded Session authorization; omission restricts explicit selection to the parent route. */
  readonly modelSelectionPolicy?: (parent: NonNullable<SubagentActivationSpec['request']['parent']>) => ModelSelectionPolicy | undefined
  /**
   * Widen the calling Session after the host asks the person directly. The host renders the question
   * from `routes`, runs `persist` only after an exact affirmative answer (with the proof), then appends the Session policy
   * entry. Absence fails closed: setup can then save only preferences that need no route confirmation.
   */
  readonly widenSession?: (
    exec: Parameters<ToolDefinition['execute']>[1],
    routes: Array<{ provider: string; model: string }>,
    steps: Omit<WidenSessionSteps<string>, 'ask'>,
  ) => Promise<WidenSessionOutcome<string>>
  /** Queue model-facing context for an Agent's next step without waking it. */
  readonly injectContext?: (agent: Agent, text: string) => void
  /** Mount the Claude hook bridge for one plugin root. */
  readonly mountHooks: (config: { configPath: string; pluginRoot: string; projectDir?: string; skipSessionStart?: boolean }) => void
  /** Register native initialization context; the host owns listener disposal. */
  readonly onAgentCreated?: (context: (isChild: boolean) => string | undefined) => void
}

/** One `agents/*.md` declaration, addressed as `<plugin>:<agent>`. */
interface NamedAgent {
  readonly type: string
  readonly description: string
  readonly body: string
  readonly path: string
  readonly effort?: string
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function absoluteFrom(value: string, base: string): string {
  const expanded = expandHome(value)
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---')) return { data: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: raw }
  const yaml = raw.slice(raw.indexOf('\n', 3) + 1, end + 1)
  const parsed: unknown = parseYaml(yaml)
  const data = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  return { data, body: raw.slice(end + 4).replace(/^\r?\n/, '') }
}

/** The plugin name Claude Code would use in `subagent_type`. */
function pluginNamespace(root: string): string {
  const manifest = join(root, '.claude-plugin', 'plugin.json')
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (typeof parsed.name === 'string' && parsed.name.length > 0) return parsed.name
    } catch {
      // A malformed manifest only costs the nicer namespace.
    }
  }
  return basename(root)
}

function discoverAgents(root: string): NamedAgent[] {
  const namespace = pluginNamespace(root)
  const agents: NamedAgent[] = []
  for (const directory of ['agents', 'effort-agents']) {
    const agentsDir = join(root, directory)
    if (!existsSync(agentsDir)) continue
    for (const entry of readdirSync(agentsDir).sort()) {
      if (!entry.endsWith('.md')) continue
      const path = join(agentsDir, entry)
      const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'))
      const declared = typeof data.name === 'string' && data.name.length > 0
        ? data.name
        : entry.slice(0, -3)
      agents.push({
        type: `${namespace}:${declared}`,
        description: typeof data.description === 'string' ? data.description : '',
        body: body.trim(),
        path,
        ...data.effort === undefined ? {} : { effort: parseEffort(data.effort, path) },
      })
    }
  }
  return agents
}

/** Effort ids are validated against the selected model during dispatch. */
function parseEffort(value: unknown, source: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || /\s/.test(value)) {
    throw new Error(`invalid reasoning effort in ${source}`)
  }
  return value
}

/** Without a host that can ask a person, only a save that needs no route confirmation succeeds. */
const withoutConfirmation: NonNullable<CompatHost['widenSession']> = async (_exec, _routes, steps) =>
  steps.unsaved.length === 0
    ? { kind: 'unchanged', revision: undefined, saved: await steps.persist(undefined) }
    : { kind: 'declined' }

/**
 * Install the compatibility tool and hook bridges on any host.
 * @param host - tool registry, subagent dispatch, LLM catalog, and hook mounting.
 * @param config - plugin roots, dispatch provider, routes, and hook toggle.
 */
export function install(host: CompatHost, config: Config): void {
  const widen = host.widenSession ?? withoutConfirmation
  const preferences = config.pstack === undefined ? loadPstackPreferences() : undefined
  const modelAliases = () => ({
    ...config.pstack === undefined ? loadPstackPreferences().modelAliases : {},
    ...config.modelAliases,
  })
  const roots = [...new Set([...config.roots.map(root => absoluteFrom(root, process.cwd())),
    ...preferences === undefined ? [] : [preferences.root ?? bundledPstackRoot()]])]
  const agents: NamedAgent[] = [
    { type: 'general-purpose', description: 'General-purpose task runner, including panel members.', body: '', path: 'native' },
    ...roots.flatMap(root => discoverAgents(root)),
  ]
  const byType = new Map(agents.map(agent => [agent.type, agent]))
  const adaptation = [
    'For every pstack Agent call, generic or named, use claude_agent, not the standard subagent tool.',
    'Use general-purpose (or omit subagent_type) for generic panel members; model aliases resolve identically for all types.',
    'Dispatch is asynchronous; run_in_background: true is accepted. Map SendMessage to send_message(agent_id, message); TaskStop to interrupt_agent(agent_id) (requests interruption, does not await exit); TaskOutput to list_agents for status, with completion delivered automatically as a message.',
    'Load skills with the skill tool using the exact catalog name; when the catalog uses bare names, pstack:poteto-mode means poteto-mode.',
    'For setup-pstack, available model names are the current configured aliases plus auto and inherit-parent. Use claude_agent_models to discover each alias route, Session authorization, and exact-model reasoning efforts (plus the inherited route). Never infer an effort is supported from its name.',
    'Effort-agent declarations apply their effort to the selected model, including auto and inherit-parent. Unsupported efforts fail explicitly.',
    'Pass model as a configured alias without provider; auto or inherit-parent inherits the parent model. reasoning_effort can change only its effort.',
    'Strip @effort from each saved role or panel entry and pass reasoning_effort separately (or select the declared effort agent). Entries without a suffix use default effort; absent default or session passes reasoning_effort: session to preserve the parent effort, overriding alias defaults. Never collapse panel entries, including inherited entries.',
    'Aliases name routes, not authorization: explicit selections require the recorded Session policy, or the parent route when no policy is recorded.',
    'Explicit type and wildcard routes are authoritative when modelSelection is off; conflicting model choices fail rather than being ignored.',
    'Model aliases, roles, and routes can change during this session. A later "pstack role sheet" message supersedes every earlier sheet and alias list; claude_agent_models returns the current aliases, roles, default effort, policyRevision, and sheetDigest and is authoritative.',
  ].join('\n')
  const pstackRoot = config.pstack === undefined
    ? preferences?.root ?? bundledPstackRoot() : absoluteFrom(config.pstack.root, process.cwd())
  const sheetPath = config.pstack === undefined ? undefined : absoluteFrom(config.pstack.sheetPath, process.cwd())
  const currentSheet = (): { readonly sheet: RoleSheet; readonly hookOff: boolean; readonly choices: RoleChoices } => {
    const loaded = loadRoleSheet(sheetPath)
    const aliases = modelAliases()
    return {
      hookOff: loaded.hookOff,
      choices: loaded.choices,
      sheet: renderRoleSheet({
        choices: loaded.choices,
        aliases,
        source: loaded.source,
        unconfiguredHint: preferences !== undefined && Object.keys(aliases).length === 0,
      }),
    }
  }
  {
    if (host.onAgentCreated === undefined) throw new Error('native pstack context requires agent initialization support')
    const mandatePath = join(pstackRoot, 'hooks', 'session-start-context.md')
    // Fail during plugin load for a missing installation, before registering effects.
    readFileSync(mandatePath, 'utf8')
    host.onAgentCreated((isChild) => {
      const { sheet, hookOff } = currentSheet()
      return [hookOff || isChild ? '' : readFileSync(mandatePath, 'utf8').trim(), adaptation, sheet.text].join('\n\n')
    })
  }

  const catalog = agents.length === 0
    ? 'No Claude Code subagent types were discovered.'
    : agents.map((agent) => {
      const route = config.models[agent.type] ?? config.models['*']
      const pinned = route === undefined ? '' : ` [model ${route.provider}/${route.model}]`
      const summary = agent.description.length > 0 ? ` — ${agent.description}` : ''
      const effort = agent.effort === undefined ? '' : ` [effort ${agent.effort}]`
      return `  - ${agent.type}${pinned}${effort}${summary}`
    }).join('\n')

  const registerAgentTool = () => host.registerTool(defineTool({
    name: 'claude_agent',
    description: [
      'Delegate any pstack Agent call: named agents and general-purpose tasks or panel members.',
      'Omitted subagent_type runs general-purpose. Every dispatch starts asynchronously and returns a child id.',
      config.modelSelection
        ? 'Pass `provider` and `model` to override the configured route for one dispatch.'
        : 'Explicit type routes come from caller configuration; otherwise select a configured model alias.',
      adaptation,
      'Available types:',
      catalog,
    ].join('\n'),
    parameters: {
      subagent_type: { type: 'string', description: 'Exact type, for example "pstack:comment-sicko"; defaults to general-purpose.' },
      run_in_background: { type: 'boolean', description: 'true or omitted starts asynchronously; false is unsupported (use native child status tools).' },
      readonly: { type: 'boolean', description: 'Deny edit/write tools and instruct the child not to mutate files or external state. Shell access remains available; this is not a read-only sandbox.' },
      reasoning_effort: { type: 'string', description: 'Model-specific effort, including when inheriting the parent model.' },
      description: { type: 'string', required: true, description: 'Short 3-5 word task label shown in the child catalog.' },
      prompt: { type: 'string', required: true, description: 'The task the child must complete. Self-contained.' },
      cwd: { type: 'string', description: 'Optional child working directory; defaults to the parent directory. With isolation, selects the source directory for the worktree service.' },
      ...host.isolateWorktree === undefined ? {} : {
        isolation: { type: 'string' as const, enum: ['worktree'], description: 'Run in a private Git worktree. Clean checkouts are removed after completion; changed checkouts are kept and reported. Outside Git, runs without isolation and reports why.' },
      },
      model: { type: 'string', description: 'Configured model alias, auto, or inherit-parent; with provider, a raw model id.' },
      ...config.modelSelection ? {
        provider: { type: 'string' as const, description: 'LLM provider id configured in the profile.' },

      } : {},
    },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (args.isolation !== undefined && host.isolateWorktree === undefined) {
        throw new Error('claude_agent worktree isolation requires the worktree service and isolation: worktree')
      }
      const agent = byType.get(args.subagent_type ?? 'general-purpose')
      if (args.run_in_background === false) throw new Error('claude_agent starts asynchronously; run_in_background: false is unsupported; use native child status tools')
      if (agent === undefined) {
        const known = agents.map(entry => entry.type).join(', ') || 'none'
        throw new Error(`unknown subagent type "${args.subagent_type}"; available: ${known}`)
      }
      const parent = exec.agent
      if (parent === undefined) throw new Error('claude_agent requires a calling agent')

      const aliases = modelAliases()
      const parentOptions = parentAgentOptionsForDelegation(parent)
      const configured = config.models[agent.type] ?? config.models['*']
      let route: Partial<RouteConfig> | undefined = configured
      if (args.provider !== undefined) {
        if (!config.modelSelection) throw new Error('raw child model selection is disabled for this tool instance')
        if (args.provider.length === 0 || args.model === undefined || args.model.length === 0) {
          throw new Error('child LLM `provider` and `model` must be supplied together and non-empty')
        }
        route = { provider: args.provider, model: args.model }
      } else if (args.model !== undefined) {
        const inherit = args.model === 'auto' || args.model === 'inherit-parent'
        const selected = inherit ? undefined : aliases[args.model]
        if (!inherit && selected === undefined) {
          throw new Error(`unknown model alias "${args.model}"; configured aliases: ${Object.keys(aliases).join(', ') || '(none)'}; use auto or inherit-parent to inherit`)
        }
        if (configured !== undefined && !config.modelSelection
          && (configured.provider !== (selected?.provider ?? parentOptions.provider)
            || configured.model !== (selected?.model ?? parentOptions.model)
            || (selected?.reasoningEffort !== undefined && selected.reasoningEffort !== configured.reasoningEffort))) {
          throw new Error('requested model conflicts with the configured route; enable modelSelection to override it')
        }
        route = configured !== undefined && !config.modelSelection ? configured : selected
      }
      const sessionEffort = args.reasoning_effort === 'session'
      const explicitEffort = sessionEffort ? parentOptions.reasoningEffort
        : args.reasoning_effort === undefined ? undefined : parseEffort(args.reasoning_effort, 'reasoning_effort')
      if (agent.effort !== undefined && explicitEffort !== undefined && agent.effort !== explicitEffort) {
        throw new Error(`conflicting reasoning efforts: declaration uses "${agent.effort}", request uses "${explicitEffort}"`)
      }
      const effort = sessionEffort ? explicitEffort : explicitEffort ?? agent.effort ?? route?.reasoningEffort
      const agentOptions = route === undefined && effort === undefined ? undefined : {
        ...route?.provider === undefined ? {} : { provider: route.provider },
        ...route?.model === undefined ? {} : { model: route.model },
        ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
      }
      // Alias lookup and declaration effort are explicit model-facing choices too.
      const selectedEffort = args.reasoning_effort ?? agent.effort
      const selection = {
        ...args.model === undefined ? {} : { model: args.model },
        ...args.provider === undefined ? {} : { provider: args.provider },
        ...selectedEffort === undefined ? {} : { reasoning_effort: selectedEffort },
      }
      assertAllowedModelSelection(host.modelSelectionPolicy?.(parent), parentOptions, agentOptions, selection)
      if (agentOptions !== undefined) {
        if (host.llm === undefined) throw new Error('cannot resolve selected child LLM route: llm service is unavailable')
        await preflightChildLlmRoute(host.llm, parentOptions, agentOptions, exec.signal, !sessionEffort)
      }
      exec.signal.throwIfAborted()

      const prompt = [
        ...args.readonly === true ? ['Read-only task: do not modify files or mutate external state, including through shell commands. The edit/write tools are denied; shell access is not a read-only sandbox.', ''] : [],
        `You are running as the "${agent.type}" subagent, declared in ${agent.path}.`,
        'Follow that declaration for your role, scope, and output shape.',
        '',
        agent.body,
        '',
        '---',
        '',
        'Task from the delegating agent:',
        '',
        args.prompt,
      ].join('\n')
      const start = (cwd: string | undefined) => host.startActivation({
        provider: config.provider,
        label: args.description,
        request: {
          prompt: [{ type: 'text', text: prompt }] as ContentBlock[],
          parent,
          ...cwd === undefined ? {} : { cwd },
          ...args.readonly === true ? { toolFilter: { deny: ['edit', 'write'] } } : {},
          ...agentOptions === undefined ? {} : { agentOptions },
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      const isolate = args.isolation === 'worktree' ? host.isolateWorktree : undefined
      if (args.isolation !== undefined && isolate === undefined) throw new Error('claude_agent worktree isolation requires the worktree service')
      const isolated = isolate === undefined ? undefined : await isolate(parent, args.cwd, cwd => start(cwd), exec.signal)
      const started = isolated?.activation ?? await start(args.cwd)
      const routeLabel = agentOptions?.provider === undefined ? 'parent route' : `${agentOptions.provider}/${agentOptions.model}`
      return `Started ${agent.type} as subagent ${started.childId} on ${routeLabel}. Its result arrives as a message.${isolated === undefined ? '' : ` ${isolated.description}`}`
    },
  }))

  let unregisterAgentTool = registerAgentTool()
  host.onWorktreeChange?.(() => {
    unregisterAgentTool()
    unregisterAgentTool = registerAgentTool()
  })

  host.registerTool(defineTool({
    name: 'claude_agent_models',
    description: 'Discover configured model aliases for setup-pstack, their Session authorization, the current role choices and default effort, and live model reasoning efforts. policyRevision and sheetDigest identify the Session policy and the role sheet in force. Catalog availability does not verify credentials. auto and inherit-parent use the inherited route. Unauthorized aliases cannot be dispatched.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          aliases: { type: 'array', items: { type: 'object', additionalProperties: true } },
          inherited: { type: 'object', additionalProperties: true },
          catalog: { type: 'array', items: { type: 'object', additionalProperties: true } },
          roles: { type: 'object', additionalProperties: true },
          defaultEffort: { type: 'string' },
          policyRevision: { type: 'number' },
          sheetDigest: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('claude_agent_models requires a calling agent')
      const aliases = modelAliases()
      const llm = host.llm
      if (llm === undefined) throw new Error('cannot discover model aliases: llm service is unavailable')
      const parentOptions = parentAgentOptionsForDelegation(parent)
      const policy = host.modelSelectionPolicy?.(parent)
      const describe = async (route: RouteConfig) => {
        const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
        return {
          ...route,
          allowed: policy === undefined
            ? route.provider === parentOptions.provider && route.model === parentOptions.model
            : policy.routes.some(allowed => allowed.provider === route.provider && allowed.model === route.model),
          efforts: (info.reasoning?.efforts ?? []).map(effort => String(effort.id)),
          ...info.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: String(info.reasoning.defaultEffort) },
        }
      }
      if (parentOptions.provider === undefined || parentOptions.model === undefined) {
        throw new Error('cannot discover inherited model without an effective provider and model')
      }
      const listModels = llm.listModels?.bind(llm)
      const catalog = llm.listProviders === undefined || listModels === undefined ? []
        : await Promise.all(llm.listProviders().map(async provider => ({
          provider: provider.id,
          models: (await listModels(provider.id)).map(model => ({ id: model.id, name: model.name })),
        })))
      const { sheet, choices } = currentSheet()
      return {
        catalog,
        roles: choices.roles,
        ...choices.defaultEffort === undefined ? {} : { defaultEffort: choices.defaultEffort },
        ...policy?.revision === undefined ? {} : { policyRevision: policy.revision },
        sheetDigest: sheet.digest,
        aliases: await Promise.all(Object.entries(aliases).map(async ([alias, route]) => {
          try {
            return { alias, ...await describe(route) }
          } catch (error) {
            exec.signal.throwIfAborted()
            return { alias, ...route, allowed: false, error: error instanceof Error ? error.message : String(error) }
          }
        })),
        inherited: await describe({ provider: parentOptions.provider, model: parentOptions.model,
          ...parentOptions.reasoningEffort === undefined ? {} : { reasoningEffort: String(parentOptions.reasoningEffort) } }),
      }
    },
  }))

  if (preferences !== undefined) host.registerTool(defineTool({
    name: 'claude_agent_setup',
    description: 'Save home-scoped pstack aliases and role choices after asking the user which models to use. Discover provider/model ids with claude_agent_models first. Routes this Session or the saved preferences do not yet authorize need a separate direct human confirmation through the host question service; unavailable or declined confirmation saves nothing. After a confirmed save the new aliases, roles, and routes apply to this Session immediately and a fresh role sheet is injected; aliases that need no new route take effect on the next discovery or dispatch. Child sessions started earlier and other open Sessions keep the authorization they already have.',
    parameters: {
      preferences_json: { type: 'string', required: true, description: 'JSON object with modelAliases (alias -> {provider,model,reasoningEffort?}) and roles (role -> alias or comma-separated alias@effort entries). Optional defaultEffort and sessionHook controls are accepted; do not supply allowedModels.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const value: unknown = JSON.parse(args.preferences_json)
      assertSetupUpdate(value)
      // Resolve every selected model and effort before publishing preferences.
      const { parsePstackPreferences } = await import('./pstack-config.ts')
      const current = loadPstackPreferences()
      const updates = value
      const validated = parsePstackPreferences({ ...current, ...updates,
        modelAliases: { ...current.modelAliases, ...typeof updates.modelAliases === 'object' && updates.modelAliases !== null && !Array.isArray(updates.modelAliases) ? updates.modelAliases : {} },
        roles: { ...current.roles, ...typeof updates.roles === 'object' && updates.roles !== null && !Array.isArray(updates.roles) ? updates.roles : {} },
      })
      if (host.llm === undefined) throw new Error('pstack setup requires the LLM catalog')
      for (const route of Object.values(validated.modelAliases)) {
        await host.llm.resolveCallConfig({ provider: route.provider, model: route.model,
          ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } }, exec.signal)
      }
      for (const choice of Object.values(validated.roles)) {
        for (const entry of choice.split(',')) {
          const [alias, suffix] = entry.split('@').map(part => part.trim())
          const route = alias === undefined ? undefined : validated.modelAliases[alias]
          const inherited = exec.agent === undefined ? undefined : parentAgentOptionsForDelegation(exec.agent)
          const provider = route?.provider ?? inherited?.provider
          const model = route?.model ?? inherited?.model
          const effort = suffix ?? validated.defaultEffort
          if (provider === undefined || model === undefined) throw new Error('setup requires an effective parent route')
          const info = await host.llm.resolveModelInfo(provider, model, exec.signal)
          if (effort !== undefined && effort !== 'session' && !(info.reasoning?.efforts ?? []).some(item => String(item.id) === effort)) {
            throw new Error(`model ${provider}/${model} does not support effort ${effort}`)
          }
        }
      }
      const routes: Array<{ provider: string; model: string }> = []
      for (const route of Object.values(validated.modelAliases)) {
        if (!routes.some(item => item.provider === route.provider && item.model === route.model)) {
          routes.push({ provider: route.provider, model: route.model })
        }
      }
      const unsaved = routes.filter(route => !current.allowedModels.some(item =>
        item.provider === route.provider && item.model === route.model))
      const parent = exec.agent
      if (parent === undefined) throw new Error('claude_agent_setup requires a calling agent')
      const outcome = await widen(exec, routes, {
        unsaved,
        persist: approval => Promise.resolve(savePstackPreferences(value, approval)),
      })
      if (outcome.kind === 'declined') {
        throw new Error('Pstack model setup was not authorized by the user; no preferences were saved')
      }
      exec.signal.throwIfAborted()
      const { sheet } = currentSheet()
      host.injectContext?.(parent, sheet.text)
      const policy = outcome.kind === 'widened'
        ? `Session policy revision ${outcome.revision} is active now.`
        : 'Session authorization is unchanged.'
      return `Saved ${outcome.saved}. ${policy} Role sheet ${sheet.digest} was injected and supersedes earlier sheets. Explicit model choices still require host-owned Session authorization.`
    },
  }))

  if (!config.hooks) return
  for (const root of roots) {
    const configPath = join(root, 'hooks', 'hooks.json')
    if (!existsSync(configPath)) continue
    host.mountHooks({
      configPath,
      pluginRoot: root,
      ...root === pstackRoot ? { skipSessionStart: true } : {},
      ...config.projectDir === undefined ? {} : { projectDir: config.projectDir },
    })
  }
}

/**
 * Cordis plugin entry: adapt the context to {@link CompatHost} and install.
 * @param ctx - host context providing tools, subagents, LLM, and plugin mounting.
 * @param config - parsed plugin configuration.
 * @returns when the Session policy projection and compatibility tools are installed.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const preferences = config.pstack === undefined ? loadPstackPreferences() : undefined
  const root = config.pstack === undefined ? preferences?.root ?? bundledPstackRoot() : absoluteFrom(config.pstack.root, process.cwd())
  await ctx.plugin(filesystemSkills, {
    providerName: 'pstack-bundled', includeDefaultRoots: false,
    bundledSkillDir: join(root, 'skills'), watch: false,
  })
  const settings = ctx.get('subagentModelSelection')
  if (settings !== undefined && config.pstack === undefined) ctx.effect(() => settings.registerAllowedModelsSource(() => {
    const routes = loadPstackPreferences().allowedModels
    return routes.length === 0 ? undefined : routes
  }))
  const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
  const askRoutes = async (routes: readonly { provider: string; model: string }[], exec: Parameters<ToolDefinition['execute']>[1]): Promise<HumanApproval | undefined> => {
    const questions = ctx.get('userQuestions')
    if (questions === undefined) return undefined
    const result = await questions.ask({
      questions: [{ id: 'pstack-routes', question: `Allow this session and future sessions to use these exact routes for pstack children? ${routes.map(route => `${route.provider}/${route.model}`).join(', ')}. Choosing Authorize routes applies them to this session now.`,
        options: [{ label: 'Authorize routes' }, { label: 'Cancel' }] }],
      ...exec.agent === undefined ? {} : { agent: exec.agent }, signal: exec.signal,
    })
    const answer = result.answers.find(item => item.id === 'pstack-routes')
    return answer?.selected.length === 1 && answer.selected[0] === 'Authorize routes' && answer.custom === undefined
      ? mintHumanApproval(routes) : undefined
  }
  const settlements = new Map<Agent, Set<Promise<unknown>>>()
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const pending = settlements.get(agent)
    if (pending !== undefined) await Promise.all(pending)
  })
  const isolateWorktree: NonNullable<CompatHost['isolateWorktree']> = async (parent, cwd, start, signal) => {
    const worktrees: WorktreeService | undefined = ctx.get('worktrees')
    if (worktrees === undefined) throw new Error('claude_agent worktree isolation requires the worktree service')
    const isolated = await worktrees.isolate(parent, cwd === undefined ? {} : { cwd }, start, (report) => {
      parent.followup(createUserMessage({
        content: [{ type: 'text', text: `Worktree kept (${report.reason}): path=${report.path} branch=${report.branch} base=${report.baseCommit} head=${report.headCommit} uncommitted=${report.uncommitted}` }],
        source: { kind: 'worktree-kept' },
      }))
    }, signal)
    const pending = settlements.get(parent) ?? new Set<Promise<unknown>>()
    settlements.set(parent, pending)
    pending.add(isolated.settled)
    void isolated.settled.then(() => {
      pending.delete(isolated.settled)
      if (pending.size === 0) settlements.delete(parent)
    })
    const location = isolated.isolation
    return {
      activation: isolated.activation,
      description: location.kind === 'worktree'
        ? `Worktree isolation: cwd=${location.cwd} branch=${location.branch} base=${location.baseLabel} (${location.baseCommit}).`
        : `Worktree isolation unavailable: ${location.reason}. Running in ${location.cwd}.`,
    }
  }
  install({
    get isolateWorktree() { return ctx.get('worktrees') === undefined ? undefined : isolateWorktree },
    onWorktreeChange: (refresh) => {
      ctx.on('internal/service', (name) => { if (name === 'worktrees') refresh() })
    },
    modelSelectionPolicy: (parent) => {
      const current = sessionPolicy(policy, parent.session)
      return current === undefined ? undefined : { routes: current.routes, revision: current.revision }
    },
    ...settings === undefined ? {} : {
      widenSession: (exec, routes, steps) => {
        if (exec.agent === undefined) throw new Error('claude_agent_setup requires a calling agent')
        return settings.widenSession(exec.agent, routes, { ...steps, ask: asked => askRoutes(asked, exec) }, exec.signal)
      },
    },
    injectContext: (agent, text) => { agent.inject(contextMessage(text)) },
    registerTool: tool => ctx.tools.register(tool),
    startActivation: spec => ctx.subagents.startActivation(spec),
    llm: ctx.get('llm'),
    onAgentCreated: (context) => {
      ctx.on('agent/created', ({ agent }) => {
        const text = context(agent.session.header.parentSession !== undefined)
        if (text !== undefined) agent.inject(contextMessage(text))
      })
    },
    mountHooks: (hookConfig) => {
      ctx.plugin(hooksBridge, hookConfig)
    },
  }, config)
}
