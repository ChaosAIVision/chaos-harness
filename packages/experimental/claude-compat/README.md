---
description: "Run an unmodified Claude Code plugin in Harness: its named subagent types, its per-role model routes, and its hooks.json, for teams migrating a Claude plugin instead of rewriting its skills."
kind: "package-reference"
---

# @deepseek-ai/dsh-claude-compat

English | [中文](README.zh.md)

## Summary

Claude Code plugins declare three things Harness has no direct equivalent for: `agents/*.md` subagent types addressed by `subagent_type`, a per-role model sheet, and command hooks in `hooks/hooks.json`. This plugin reads a configured list of Claude plugin roots and supplies all three on top of the ordinary `ctx.tools`, `ctx.subagents`, and hook seams. Skills themselves already load through `skill-filesystem`; this package covers the rest of the plugin, so a migration can keep its directory layout.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin after the tools and subagent registries, pointing `roots` at one or more plugin directories.

```yaml
- id: claude-compat
  name: '/absolute/path/to/harness/packages/experimental/claude-compat/src/index.ts'
  config:
    roots:
      - '~/.agents/pstack-plugin'
    provider: spawn
    hooks: true
```

The row names an absolute source path because this package is unpublished and its peer dependencies are `workspace:*`, which a profile install cannot resolve; once published, the package name works instead. [`example-overlay.yml`](example-overlay.yml) is the same block, ready for `--patch`.

The directory is read the way Claude Code reads it: `.claude-plugin/plugin.json` supplies the namespace in `subagent_type`, `agents/*.md` supplies each type, and `hooks/hooks.json` supplies the hook config. A root without a manifest uses its directory name as the namespace.

| Field | Default | Meaning |
|---|---|---|
| `roots` | `['~/.agents/pstack-plugin']` | Plugin roots in priority order; `~` expands. |
| `provider` | `spawn` | `ctx.subagents` provider used for every dispatch. |
| `models` | `{}` | Route per type: `{ provider, model, reasoningEffort? }`. `"*"` is the fallback; an unlisted type inherits the parent route. |
| `modelAliases` | `{}` | Model-only names mapped to `{ provider, model, reasoningEffort? }`; no built-in model fallback. |
| `pstack` | unset | Native initialization: `{ root, sheetPath }`; reads the installed mandate and configured sheet without a Claude subprocess. |
| `modelSelection` | `false` | Permit raw provider/model/effort overrides of `models`. |
| `hooks` | `true` | Mount a `dsh-hooks-claude-code` bridge for each root with `hooks/hooks.json`. |
| `projectDir` | session directory | `CLAUDE_PROJECT_DIR` handed to hook commands. |

### Route a role to a model saved in the profile

```yaml
models:
  '*': { provider: local, model: glm-5.3, reasoningEffort: high }
  'pstack:comment-sicko': { provider: local, model: deepseek-v4.1-flash }
```

Most providers advertise `high` as a reasoning effort; an effort the model does not list is rejected rather than silently downgraded, and the error names the available levels. A route supplied by the model (`modelSelection: true`) is resolved against the live catalog first, including that effort list, because model output is untrusted. A route written in configuration is trusted operator input: the provider id is checked and the model id is left to the provider, which reports its own error at spawn.

### Model aliases and native pstack context

Configure `modelAliases` with any names, including `opus`, `fable`, `sonnet`, or `haiku`. A model-only call such as `model: opus` selects that configured route. Unknown names fail with the available alias list. With `modelSelection: false`, exact type routes, then wildcard routes, take precedence over aliases; otherwise explicit selection wins. `auto` and `inherit-parent` omit child options when no authoritative route applies. Alias mappings are trusted operator routes; the existing per-session selection-policy limitation below also applies to aliases.

Set `pstack: { root: '~/.agents/pstack-plugin', sheetPath: '/absolute/path/to/pstack-models.md' }` to inject saved role lines and native tool guidance at initialization. The installed `hooks/session-start-context.md` supplies the poteto-mode mandate for roots only. An exact `session hook: off` line suppresses that mandate, not role choices or tool guidance. UTF-8 BOM, UTF-16LE BOM, and CRLF sheets are supported. Missing files fail rather than silently selecting a model. Context remains enabled with `hooks: false`; with hooks on, only that root's bridged SessionStart is suppressed. Other hook points remain active.

### What the model sees

`claude_agent` replaces the reference `Agent` call: the same `subagent_type`, `description`, and `prompt`, plus an optional `cwd`. The tool description lists every discovered type and marks the ones with a pinned route, so the model does not have to guess whether a type exists.

<a id="understand-the-implementation"></a>
## Understand the implementation

`install(host, config)` holds every decision and `apply` adapts a Cordis context to the small `CompatHost` seam: register a tool, start an activation, read the LLM catalog, mount a hook bridge. Discovery reads each root once at load; a child receives the agent declaration as the head of its prompt, because `SubagentStartRequest` has no inline system-prompt slot.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Discovery, `claude_agent`, route resolution and validation, hook mounting. |
| [`tests/claude-compat.spec.ts`](tests/claude-compat.spec.ts) | Behavior without a profile: discovery, dispatch payload, routes, rejections, hooks. |
| [`tests/e2e.ts`](tests/e2e.ts) | Manual end-to-end run against the mock LLM; asserts the captured wire request and the child session. |
| [`example-overlay.yml`](example-overlay.yml) | Copy-ready insert block. |

<a id="further-exploration"></a>
## Further Exploration

- [Skills subsystem](../../../docs/subsystems/skills.md) — how `SKILL.md` frontmatter already maps onto the catalog.
- [Subagents subsystem](../../../docs/subsystems/subagent.md) — the activation contract this tool dispatches through.
- [`dsh-hooks-claude-code`](../hooks-claude-code/README.md) — the hook bridge mounted per root, including its command-hook subset.

<a id="model-experience"></a>
## Model Experience

### Tool catalog entry

#### What the model sees

`claude_agent` with its description: every discovered `<plugin>:<agent>` type, each marked with its pinned route when one is configured, plus the parameter list (`subagent_type`, `description`, `prompt`, `cwd`, `model` for aliases, and `provider`/`reasoning_effort` only while `modelSelection` is on). Nothing is registered when no root has an `agents/` directory.

#### Token effect

One description line per discovered type; a large plugin root grows the catalog proportionally. The text is configuration-derived and identical across turns, so it costs those tokens once and stays in the reusable prefix.

#### KV Cache effect

Stable while the mounted roots and routes do not change. A reload with a new type or a different pinned route produces a different description and therefore a fresh prefix.

### Dispatched child

#### What the model sees

The child's first user message begins with the agent declaration and the delegating task. The parent sees only the tool result naming the type, the child id, and the route. The child's own turns never enter the parent's context, and the parent's history is not sent to the child.

#### Token effect

The parent pays one short tool result. The child pays its own full context: the declaration, the task, and the provider's system prompt. A pinned route neither adds nor removes parent tokens.

#### KV Cache effect

The parent's request prefix is unchanged by the dispatch. A child on the parent route can reuse the parent's provider-side cache lineage; a child pinned to another model starts a separate lineage that shares nothing with the parent.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `paths:` frontmatter stays inert: glob-gated auto-attach is consumer behavior in `dsh-tool-skill`.
- An explicit route bypasses the per-session `subagent/model-selection-policy` projection, which `dsh-tool-subagent` enforces. Keep `modelSelection: false` and pin routes in configuration when the Session authorizes a narrower set.
- Persona travels in the child prompt, not its system prompt.
- Discovery is read once at plugin load; a new `agents/*.md` needs a reload. `effort-agents` declarations are not loaded.
- Native sheet context includes simple role lines, not arbitrary Markdown; it does not validate the complete upstream panel/role schema.
- The hook bridge runs command hooks only, matching `dsh-hooks-claude-code`'s documented subset.

### Dev Note

`tests/e2e.ts` is not part of the vitest suite: it boots a real headless profile against `llm-mock-server` and costs a few seconds. Run it by hand after touching dispatch or routing:

```sh
node --import tsx/esm packages/experimental/claude-compat/tests/e2e.ts
node --import tsx/esm packages/experimental/claude-compat/tests/pstack-native.e2e.ts
E2E_MODEL_ROUTE=deepseek-official/deepseek-v4-flash \
  node --import tsx/esm packages/experimental/claude-compat/tests/e2e.ts
```
