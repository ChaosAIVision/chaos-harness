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
- [DSH runtime mapping for pstack](#dsh-runtime-mapping-for-pstack)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

For native pstack, use the [global setup](#global-pstack-setup) below. Manual plugin mounting is for other Claude plugins or advanced profile customization: mount after the tools and subagent registries, pointing `roots` at one or more plugin directories.

```yaml
- id: claude-compat
  name: '/absolute/path/to/harness/packages/context/claude-compat/src/index.ts'
  config:
    roots:
      - '~/.agents/pstack-plugin'
    provider: spawn
    hooks: true
```

The manual row names an absolute source path because this package is unpublished and its peer dependencies are `workspace:*`, which a profile install cannot resolve. [`example-overlay.yml`](example-overlay.yml) provides this optional advanced `--patch` configuration; native pstack does not require a per-launch patch.

The directory is read the way Claude Code reads it: `.claude-plugin/plugin.json` supplies the namespace in `subagent_type`, `agents/*.md` and `effort-agents/*.md` supply named types, and `hooks/hooks.json` supplies the hook config. A root without a manifest uses its directory name as the namespace.

| Field | Default | Meaning |
|---|---|---|
| `roots` | `[]` | Additional plugin roots in priority order; `~` expands. Global pstack resources load separately. |
| `provider` | `spawn` | `ctx.subagents` provider used for every dispatch. |
| `models` | `{}` | Route per type: `{ provider, model, reasoningEffort? }`. `"*"` is the fallback; an unlisted type inherits the parent route. |
| `modelAliases` | `{}` | Model-only names mapped to `{ provider, model, reasoningEffort? }`; no built-in model fallback. |
| `pstack` | unset | Native initialization: `{ root, sheetPath }`; reads the installed mandate and configured sheet without a Claude subprocess. |
| `modelSelection` | `false` | Permit raw provider/model/effort overrides of `models`. |
| `hooks` | `true` | Mount a `dsh-hooks-claude-code` bridge for each root with `hooks/hooks.json`. |
| `projectDir` | session directory | `CLAUDE_PROJECT_DIR` handed to hook commands. |

<a id="global-pstack-setup"></a>
### Global pstack setup

Native profiles ship pstack skills and agent declarations with DSH; no external plugin installation, `--patch`, or project-local config is required. At startup, DSH creates `$DSH_HOME/pstack/config.json` when it is absent; `DSH_HOME` defaults to `~/.dsh`. Its absolute `root` points to the bundled resources. An existing file keeps its configured external root and preferences; these paths do not depend on the working directory.

The bundled [vendoring manifest](resources/pstack/upstream.json) records the upstream release, source attribution, file checksums, and retained licenses and notices.

On first use, ask the agent to run `setup-pstack`. It uses `claude_agent_models` to discover provider/model ids and model-specific efforts, asks which models you want, then calls `claude_agent_setup` with `preferences_json`, a JSON string containing `modelAliases` and `roles`, with optional `defaultEffort` and `sessionHook`. Keep inherited roles if you do not want additional model routes. For new alias routes, the host asks for direct human confirmation through `userQuestions`: select exactly `Authorize routes` to save those routes in `allowedModels`. Cancellation or unavailable confirmation leaves the saved preferences unchanged. Open a fresh Session after saving to load aliases and authorization; the current Session's permissions do not change.

The generated file has no aliases or additional authorized routes. All shipped roles inherit the parent model, multi-member panels retain their separate inherited entries, `defaultEffort` is `session`, and `sessionHook` is `true`. Until model setup is complete, delegation inherits the parent route rather than inventing aliases. Invalid preferences or a configured root missing its mandate fail rather than silently falling back.

DSH does not provision API keys or provider accounts. Configure a working parent model and provider credentials before starting a Session; setup discovers the existing live model catalog and does not install providers or verify credentials.

The operator can maintain this complete file; replace the example root and route ids with your installation and catalog values:

```json
{
  "version": 1,
  "root": "/absolute/path/to/pstack-plugin",
  "modelAliases": {
    "fast": { "provider": "local", "model": "deepseek-v4.1-flash" }
  },
  "roles": {
    "default": "fast",
    "review panel": "fast@high, inherit-parent"
  },
  "allowedModels": [
    { "provider": "local", "model": "deepseek-v4.1-flash" }
  ]
}
```

`version` must be `1`. Alias names use letters, digits, `_`, or `-`; `auto` and `inherit-parent` are reserved. Role values contain known aliases or those inherited-route markers, optionally suffixed with `@effort` and separated by commas. Invalid JSON, unknown fields, unknown role aliases, relative roots, and duplicate authorization pairs are rejected. Setup also validates alias routes and their configured efforts against the live catalog; catalog discovery does not verify credentials.

For advanced manual mounts, an explicit `pstack: { root, sheetPath }` selects the legacy sheet instead of global preferences. Otherwise, profile `modelAliases` override global aliases with the same name, and configured roots are combined with the global root. Host model-selection settings remain authoritative for Session authorization; see [saved models, effort, and authorization](#saved-models-effort-and-authorization).

### Route a role to a model saved in the profile

```yaml
models:
  '*': { provider: local, model: glm-5.3, reasoningEffort: high }
  'pstack:comment-sicko': { provider: local, model: deepseek-v4.1-flash }
```

Selected child options are preflighted against the live model catalog before dispatch. Unsupported reasoning efforts fail rather than silently downgrade. The Session policy authorizes explicit model or effort selections; operator-configured defaults without an explicit selection remain distinct from that authorization.

### Model aliases and native pstack context

Configure `modelAliases` with any names, including `opus`, `fable`, `sonnet`, or `haiku`; none is built in. Unknown aliases fail with the available alias list. With `modelSelection: false`, exact type routes and then wildcard routes are authoritative: conflicting model requests fail instead of being ignored. With `modelSelection: true`, explicit selection can override those routes. Aliases resolve identically for generic, named, and effort agents, and do not grant Session authorization.

Set `pstack: { root: '~/.agents/pstack-plugin', sheetPath: '/absolute/path/to/pstack-models.md' }` to inject saved role lines and native tool guidance at initialization. The installed `hooks/session-start-context.md` supplies the poteto-mode mandate for roots only. An exact `session hook: off` line suppresses that mandate, not role choices or tool guidance. UTF-8 BOM, UTF-16LE BOM, and CRLF sheets are supported. Missing files fail rather than silently selecting a model. Context remains enabled with `hooks: false`; with hooks on, only that root's bridged SessionStart is suppressed. Other hook points remain active.

### What the model sees

`claude_agent` replaces the reference `Agent` call: the same `subagent_type`, `description`, and `prompt`, plus an optional `cwd`. The tool description lists every discovered type and marks the ones with a pinned route, so the model does not have to guess whether a type exists.

<a id="dsh-runtime-mapping-for-pstack"></a>
## DSH runtime mapping for pstack

This is the canonical reference for adapting pstack instructions to the native DSH runtime. Bundled pstack resources, or an explicitly configured external root, supply declarations and skills; DSH supplies dispatch, authorization, messaging, and completion delivery.

### Agent types and skills

Use `claude_agent` for every pstack `Agent` call, including generic panel members, rather than mixing it with the standard `subagent` tool. Omit `subagent_type`, or use `general-purpose`, for a generic task. Named types use the exact discovered namespace and declaration name. With the bundled pstack declarations, the four base types are `pstack:poteto-agent`, `pstack:comment-sicko`, `pstack:thermo-nuclear-review-subagent`, and `pstack:thermo-nuclear-code-quality-review-subagent`.

The ten effort types are `pstack:effort-low`, `pstack:effort-medium`, `pstack:effort-high`, `pstack:effort-xhigh`, `pstack:effort-max`, and `pstack:poteto-agent-low`, `pstack:poteto-agent-medium`, `pstack:poteto-agent-high`, `pstack:poteto-agent-xhigh`, `pstack:poteto-agent-max`. Together these are 14 discovered named types, in addition to native `general-purpose`. Discovery depends on the selected resource files; the tool description is authoritative for the current Session. Declaration effort applies to the selected model, including inherited models; an unsupported effort or a conflicting explicit effort fails.

Load skills through `skill` with the exact catalog name. A pstack instruction saying `pstack:poteto-mode` means `poteto-mode` when the skill catalog exposes that bare name; do not invent namespaced names or assume agent declarations register skills.

<a id="saved-models-effort-and-authorization"></a>

### Saved models, effort, and authorization

Use global `modelAliases` and `roles`, or the explicit legacy `pstack: { root, sheetPath }` configuration. For each saved role or panel entry, pass its alias as `model` without `provider`. `auto` and `inherit-parent` select the parent model when no authoritative configured route applies. Split an `@effort` suffix into a separate `reasoning_effort` argument, or use the corresponding effort-agent declaration. An entry without a suffix uses the sheet's default effort; an absent default or `session` must pass `reasoning_effort: session`. This marker preserves the parent's effort rather than an alias's configured effort, and validates that effort against the target model. This sheet interpretation is an instruction to the delegating agent, not an automatic sheet-to-dispatch parser. Do not collapse panel entries, including repeated inherited entries.

Aliases identify routes, not permissions. Explicit alias, raw model, or effort selections must resolve to an exact provider/model pair authorized by the recorded `subagent/model-selection-policy`; without a recorded policy, only the current parent pair is allowed. Pure inheritance does not require explicit selection. `modelSelection` controls raw route overrides and configured-route precedence, not Session permission.

Global `allowedModels` contains exact routes approved through setup or configured by the operator. Host `subagent-model-selection-settings` with `enabled: false` vetoes authorization before consulting sources; `enabled: true` uses only its explicit host routes, while `enabled: null` defers to registered sources. For a manual mount, configure exact `{ provider, model }` pairs in its `allowedModels` list. Setup cannot override this host policy or accept model-authored `allowedModels`. Settings are sampled for fresh top-level Sessions and inherited by children; changing settings does not broaden an existing Session's recorded policy. See the [route-authorization upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.3/claude-compat-route-authorization/guide.md).

For `setup-pstack`, use `claude_agent_models` to discover configured alias names, each alias's exact route, Session authorization (`allowed`), supported `efforts`, and advertised `defaultEffort` when present, plus the inherited route. Offer authorized configured aliases plus `auto` and `inherit-parent`; catalog availability does not verify credentials. Saved alias spelling, including uppercase letters, is preserved. A metadata lookup failure is returned as an error on that alias with `allowed: false`, rather than hiding the other aliases. Do not infer support for `max`, `xhigh`, or any other effort from another model's capabilities. The native `list_subagent_models` supplies policy-authorized raw routes, not compat aliases. Raw provider/model selection also requires compat `modelSelection: true`.

### Readonly and working directories

`readonly: true` passes `toolFilter: { deny: ['edit', 'write'] }` to the child and instructs it not to mutate files or external state, including through shell commands. Direct `edit` and `write` are removed from its available tools. Bash remains available: this is not a read-only filesystem or shell sandbox, and does not prevent every possible mutation. Spawn and fork support this filter, including after cold resume; providers without the `toolFilter` capability reject the request.

Pass `cwd` to select the child's working directory; omission uses the parent's directory. There is no compat `isolation: worktree` option. Create a worktree manually before dispatch, pass its absolute path as `cwd`, and manage its review, merge, and cleanup separately. Neither a new child nor a different `cwd` creates filesystem isolation automatically.

### Background results and controls

Every `claude_agent` dispatch is asynchronous. `run_in_background: true` and omission both return a child id; `run_in_background: false` is rejected. The final answer arrives automatically as a completion message, not as the initial tool result. Use the native controls supplied by `dsh-tool-subagent-control`:

| pstack instruction | DSH operation | Meaning |
|---|---|---|
| `SendMessage` | `send_message(agent_id, message)` | Returns message acceptance, not the reply. A working local target is steered at its next step; an idle direct child starts another turn. |
| `TaskStop` | `interrupt_agent(agent_id)` | Requests interruption; returns acceptance without waiting for exit or quiet. Local children stop their current turn and remain continuable; descendants are not stopped automatically. |
| `TaskOutput` | `list_agents` plus automatic completion message | Lists status rather than fetching or waiting for a final answer. The completion message contains the result. |

There is no `stop_subagent` control. A parent can message its direct continuable children; a resident child can message its direct parent. An ancestor can interrupt a running descendant. Local continuation can cold-resume an inactive direct child when persistence, Session query, and its recorded composition are available; it is not a promise to resume arbitrary ids or external one-shot backends. `list_agents` does not itself load or resume children and omits one-shot children. See [native controls](../../subagent/tool-subagent-control/README.md) and [child composition restoration](../../subagent/subagent/README.md#restoring-child-composition) for restrictions.

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

`claude_agent` describes native `general-purpose` and every discovered named type, with pinned-route markers where configured. Its parameters include `subagent_type`, `description`, `prompt`, `cwd`, `model`, `reasoning_effort`, `readonly`, and `run_in_background`; `provider` is exposed only with `modelSelection` on. Generic dispatch remains available without discovered declarations.

#### Token effect

One description line per discovered type; a large plugin root grows the catalog proportionally. The text is configuration-derived and identical across turns, so it costs those tokens once and stays in the reusable prefix.

#### KV Cache effect

Stable while the mounted roots and routes do not change. A reload with a new type or a different pinned route produces a different description and therefore a fresh prefix.

### Dispatched child

#### What the model sees

The child's initial task includes the agent declaration, delegating task, and any readonly instruction. The parent first receives the type, child id, and route, then a completion message with the final answer. Internal child turns remain in its own Session. The default spawn provider does not copy the parent's history.

#### Token effect

The parent pays one short tool result. The child pays its own full context: the declaration, the task, and the provider's system prompt. A pinned route neither adds nor removes parent tokens.

#### KV Cache effect

The parent's request prefix is unchanged by the dispatch. A child on the parent route can reuse the parent's provider-side cache lineage; a child pinned to another model starts a separate lineage that shares nothing with the parent.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `paths:` frontmatter stays inert: glob-gated auto-attach is consumer behavior in `dsh-tool-skill`.
- Persona travels in the child prompt, not its system prompt.
- Discovery reads `agents/*.md` and `effort-agents/*.md` once at plugin load; new declarations need a reload.
- Native sheet context includes simple role lines, not arbitrary Markdown; it does not validate the complete upstream panel/role schema.
- The hook bridge runs command hooks only, matching `dsh-hooks-claude-code`'s documented subset.

### Dev Note

`tests/e2e.ts` is not part of the vitest suite: it boots a real headless profile against `llm-mock-server` and costs a few seconds. Run it by hand after touching dispatch or routing:

```sh
node --import tsx/esm packages/context/claude-compat/tests/e2e.ts
node --import tsx/esm packages/context/claude-compat/tests/pstack-native.e2e.ts
E2E_MODEL_ROUTE=deepseek-official/deepseek-v4-flash \
  node --import tsx/esm packages/context/claude-compat/tests/e2e.ts
```
