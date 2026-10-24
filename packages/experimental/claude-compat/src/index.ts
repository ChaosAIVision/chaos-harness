/**
 * Compatibility shim for Claude Code plugin directories.
 *
 * Claude Code plugins carry capabilities Harness has no native equivalent for:
 * named subagent types (`subagent_type: "pstack:comment-sicko"`) declared as
 * `agents/*.md`, per-role model selection from a saved sheet, and
 * `hooks/hooks.json`. This plugin reads a configured list of plugin roots and
 * adds all three: one `claude_agent` tool that dispatches a named agent through
 * `ctx.subagents` with an optional configured LLM route, and a mounted
 * `dsh-hooks-claude-code` bridge per root that has a hook config.
 *
 * @module @deepseek-ai/dsh-claude-compat
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import * as hooksBridge from '@deepseek-ai/dsh-hooks-claude-code'
import { parse as parseYaml } from 'yaml'

export const name = 'experimental-claude-compat'

export const inject = ['tools', 'subagents']

/** One configured child LLM route. */
export interface RouteConfig {
  provider: string
  model: string
  reasoningEffort?: string
}

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
  /** Let model-supplied `provider`/`model`/`reasoning_effort` override `models`. */
  modelSelection: boolean
  /** Mount a hook bridge for each root that has `hooks/hooks.json`. */
  hooks: boolean
  /** Working directory handed to hook commands; defaults to the session directory. */
  projectDir?: string
}

export const Config: z<Config> = z.object({
  roots: z.array(z.string()).default(['~/.agents/pstack-plugin']),
  provider: z.string().default('spawn'),
  models: z.dict(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  })).default({}),
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
  readonly startActivation: (spec: SubagentActivationSpec) => Promise<{ childId: string }>
  /** LLM catalog, when the host mounts one. */
  readonly llm: Pick<LlmRuntime, 'listProviders' | 'resolveModelInfo'> | undefined
  /** Mount the Claude hook bridge for one plugin root. */
  readonly mountHooks: (config: { configPath: string; pluginRoot: string; projectDir?: string }) => void
}

/** One `agents/*.md` declaration, addressed as `<plugin>:<agent>`. */
interface NamedAgent {
  readonly type: string
  readonly description: string
  readonly body: string
  readonly path: string
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
  const agentsDir = join(root, 'agents')
  if (!existsSync(agentsDir)) return []
  const namespace = pluginNamespace(root)
  const agents: NamedAgent[] = []
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
    })
  }
  return agents
}

/** Merge a configured route with explicit arguments, arguments last. */
function mergeRoute(
  configured: Partial<RouteConfig> | undefined,
  args: { provider?: string; model?: string; reasoning_effort?: string },
): Partial<RouteConfig> {
  const merged: Partial<RouteConfig> = { ...configured }
  if (args.provider !== undefined) merged.provider = args.provider
  if (args.model !== undefined) merged.model = args.model
  if (args.reasoning_effort !== undefined) merged.reasoningEffort = args.reasoning_effort
  return merged
}

/**
 * Install the compatibility tool and hook bridges on any host.
 * @param host - tool registry, subagent dispatch, LLM catalog, and hook mounting.
 * @param config - plugin roots, dispatch provider, routes, and hook toggle.
 */
export function install(host: CompatHost, config: Config): void {
  const roots = config.roots.map(root => absoluteFrom(root, process.cwd()))
  const agents = roots.flatMap(root => discoverAgents(root))
  const byType = new Map(agents.map(agent => [agent.type, agent]))

  const catalog = agents.length === 0
    ? 'No Claude Code subagent types were discovered.'
    : agents.map((agent) => {
      const route = config.models[agent.type] ?? config.models['*']
      const pinned = route === undefined ? '' : ` [model ${route.provider}/${route.model}]`
      const summary = agent.description.length > 0 ? ` — ${agent.description}` : ''
      return `  - ${agent.type}${pinned}${summary}`
    }).join('\n')

  host.registerTool(defineTool({
    name: 'claude_agent',
    description: [
      'Delegate to a named Claude Code subagent type (the `Agent` tool with `subagent_type`).',
      'Use this whenever a skill says `subagent_type: "<plugin>:<agent>"` instead of inventing a generic subagent.',
      config.modelSelection
        ? 'Pass `provider` and `model` to override the configured route for one dispatch.'
        : 'The route comes from the caller configuration; do not pass a model.',
      'Available types:',
      catalog,
    ].join('\n'),
    parameters: {
      subagent_type: { type: 'string', required: true, description: 'Exact type, for example "pstack:comment-sicko".' },
      description: { type: 'string', required: true, description: 'Short 3-5 word task label shown in the child catalog.' },
      prompt: { type: 'string', required: true, description: 'The task the child must complete. Self-contained.' },
      cwd: { type: 'string', description: 'Optional child working directory; defaults to the parent directory.' },
      ...config.modelSelection ? {
        provider: { type: 'string' as const, description: 'LLM provider id configured in the profile.' },
        model: { type: 'string' as const, description: 'Model id advertised by that provider.' },
        reasoning_effort: { type: 'string' as const, description: 'Reasoning effort id advertised by that model.' },
      } : {},
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const agent = byType.get(args.subagent_type)
      if (agent === undefined) {
        const known = agents.map(entry => entry.type).join(', ') || 'none'
        throw new Error(`unknown subagent type "${args.subagent_type}"; available: ${known}`)
      }
      const parent = exec.agent
      if (parent === undefined) throw new Error('claude_agent requires a calling agent')

      const configured = config.models[agent.type] ?? config.models['*']
      const suppliedByModel = config.modelSelection
        && (args.provider !== undefined || args.model !== undefined || args.reasoning_effort !== undefined)
      const route = mergeRoute(configured, config.modelSelection ? args : {})
      if (route.model !== undefined && route.provider === undefined) {
        throw new Error('`model` requires `provider`')
      }
      if (route.provider !== undefined && route.model === undefined) {
        throw new Error('`provider` requires `model`')
      }

      let agentOptions: { provider: string; model: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId> } | undefined
      if (route.provider !== undefined && route.model !== undefined) {
        // A configured route is trusted operator input, like any profile field;
        // a model-supplied route is validated against the live catalog first.
        const llm = host.llm
        if (llm !== undefined) {
          const known = llm.listProviders().map(entry => entry.id)
          if (!known.includes(route.provider)) {
            throw new Error(`LLM provider "${route.provider}" is not registered; available: ${known.join(', ') || '(none)'}`)
          }
          if (suppliedByModel) {
            const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
            const efforts = (info.reasoning?.efforts ?? []).map(effort => String(effort.id))
            if (route.reasoningEffort !== undefined && !efforts.includes(route.reasoningEffort)) {
              throw new Error(
                `model "${route.provider}/${route.model}" has no reasoning effort "${route.reasoningEffort}"; available: ${efforts.join(', ') || '(none)'}`,
              )
            }
          }
        }
        agentOptions = {
          provider: route.provider,
          model: route.model,
          ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
        }
      }

      const prompt = [
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
      const started = await host.startActivation({
        provider: config.provider,
        label: args.description,
        request: {
          prompt: [{ type: 'text', text: prompt }] as ContentBlock[],
          parent,
          ...args.cwd === undefined ? {} : { cwd: args.cwd },
          ...agentOptions === undefined ? {} : { agentOptions },
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      const routeLabel = agentOptions === undefined ? 'parent route' : `${agentOptions.provider}/${agentOptions.model}`
      return `Started ${agent.type} as subagent ${started.childId} on ${routeLabel}. Its result arrives as a message.`
    },
  }))

  if (!config.hooks) return
  for (const root of roots) {
    const configPath = join(root, 'hooks', 'hooks.json')
    if (!existsSync(configPath)) continue
    host.mountHooks({
      configPath,
      pluginRoot: root,
      ...config.projectDir === undefined ? {} : { projectDir: config.projectDir },
    })
  }
}

/**
 * Cordis plugin entry: adapt the context to {@link CompatHost} and install.
 * @param ctx - host context providing tools, subagents, LLM, and plugin mounting.
 * @param config - parsed plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  install({
    registerTool: tool => ctx.tools.register(tool),
    startActivation: spec => ctx.subagents.startActivation(spec),
    llm: ctx.get('llm'),
    mountHooks: (hookConfig) => {
      ctx.plugin(hooksBridge, hookConfig)
    },
  }, config)
}
