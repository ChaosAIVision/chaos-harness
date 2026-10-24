---
kind: upgrade-guide
description: "Explicit claude_agent model and effort selections now require recorded Session route authorization instead of bypassing it."
---

# Authorize explicit claude_agent model routes

English | [中文](guide.zh.md)

## Change

`claude_agent` previously bypassed the Session model-selection policy for explicit routes, including model aliases. Explicit alias, raw model, and effort selections now enforce `subagent/model-selection-policy`, just as native delegation does. Without a recorded policy, only the current parent provider/model pair is permitted. An alias does not authorize its route, and compat `modelSelection: true` does not grant permission.

Native profiles now ship pstack skills and agents and create the global preferences file when absent, instead of requiring an external installation or leaving initialization inactive. Existing configured external roots remain selected.

With compat `modelSelection: false`, a request conflicting with a configured type or wildcard route now fails instead of silently using the configured route. Selected child options are preflighted against the live catalog, including supported reasoning efforts.

## Migration

1. For native pstack, remove any pstack-only per-launch `--patch`; no external plugin installation is needed. Startup creates `$DSH_HOME/pstack/config.json` (`~/.dsh/pstack/config.json` by default) if absent, using bundled resources, inherited role routes and effort, and the enabled session hook. Existing preferences, including external `root`, are preserved. Configure a working parent model and credentials first; DSH does not provision API keys. Run `setup-pstack` to select models from the existing live catalog and save aliases and roles. New alias routes require direct human confirmation through `userQuestions`: select exactly `Authorize routes`. Cancellation or unavailable confirmation leaves saved preferences unchanged. See [global setup](../../../../packages/context/claude-compat/README.md#global-pstack-setup).
2. Confirm the exact provider/model pairs needed by explicit alias or effort selections during setup; no hand-edit is required. Host `subagent-model-selection-settings` with `enabled: false` vetoes authorization before consulting sources; `enabled: true` uses only its explicit host routes, and `enabled: null` defers to registered sources. Without saved aliases or authorization, the bundled default uses the parent route; it does not invent aliases or grant access to other models.

3. Settings reach fresh top-level Sessions only. A confirmed `claude_agent_setup` widens its own running Session at once and injects a new role sheet; editing the config file widens nothing. Earlier children and other open Sessions keep their authorization; later children inherit the parent's current policy.
4. For advanced manual mounts, keep compat `modelSelection: false` unless raw provider/model overrides or overriding configured type routes are required. When it is false, remove conflicting selections or align them with the configured route. Use only reasoning efforts advertised for the exact selected model.
5. Confirm discovery and dispatch in the Session that ran setup or a fresh one: use `claude_agent_models` to inspect alias authorization and exact-model efforts, then run a generic and a named `claude_agent` task with an authorized alias. Both should return child ids and deliver completion messages. An explicit route absent from the recorded policy must fail before a child starts. See the [canonical runtime mapping](../../../../packages/context/claude-compat/README.md#dsh-runtime-mapping-for-pstack).

Direct JavaScript callers must now await `install(host, config)` and `savePstackPreferences(update, approval?)`. Installation initializes the catalog before reading preferences. Saving accepts the same JSON edit but returns `Promise<string>` and can reject a stale concurrent snapshot; repeat discovery and obtain fresh confirmation rather than retrying old approval. `loadPstackPreferences()` remains synchronous and initializes safe empty defaults when absent.
