---
kind: upgrade-guide
description: "Explicit claude_agent model and effort selections now require recorded Session route authorization instead of bypassing it."
---

# Authorize explicit claude_agent model routes

English | [中文](guide.zh.md)

## Change

`claude_agent` previously bypassed the Session model-selection policy for explicit routes, including model aliases. Explicit alias, raw model, and effort selections now enforce `subagent/model-selection-policy`, just as native delegation does. Without a recorded policy, only the current parent provider/model pair is permitted. An alias does not authorize its route, and compat `modelSelection: true` does not grant permission.

With compat `modelSelection: false`, a request conflicting with a configured type or wildcard route now fails instead of silently using the configured route. Selected child options are preflighted against the live catalog, including supported reasoning efforts.

## Migration

1. For native pstack, stop passing a per-launch `--patch`. Save your existing aliases and role choices once in `$DSH_HOME/pstack/config.json` (`~/.dsh/pstack/config.json` by default), with `version: 1`, an absolute installed `root`, `modelAliases`, `roles`, and operator-owned `allowedModels`. Use `setup-pstack` for interactive model selection: `claude_agent_models` discovers choices and `claude_agent_setup` saves aliases and roles, and requests direct human confirmation through `userQuestions` before adding new alias routes to `allowedModels`. Select exactly `Authorize routes` to approve; cancellation or unavailable confirmation saves nothing. See the [global setup and complete file example](../../../../packages/context/claude-compat/README.md#global-pstack-setup).
2. Confirm the exact provider/model pairs needed by explicit alias or effort selections during setup; no hand-edit is required. Host `subagent-model-selection-settings` with `enabled: false` vetoes authorization before consulting sources; `enabled: true` uses only its explicit host routes, and `enabled: null` defers to registered sources. Without saved aliases or authorization, the installed default uses the parent route; it does not invent aliases or grant access to other models.

3. Start a fresh top-level Session after updating settings. Existing Sessions retain their recorded authorization; reloading config does not broaden it. Child Sessions inherit the parent's policy.
4. For advanced manual mounts, keep compat `modelSelection: false` unless raw provider/model overrides or overriding configured type routes are required. When it is false, remove conflicting selections or align them with the configured route. Use only reasoning efforts advertised for the exact selected model.
5. Confirm discovery and dispatch in the fresh Session: use `claude_agent_models` to inspect alias authorization and exact-model efforts, then run a generic and a named `claude_agent` task with an authorized alias. Both should return child ids and deliver completion messages. An explicit route absent from the recorded policy must fail before a child starts. See the [canonical runtime mapping](../../../../packages/context/claude-compat/README.md#dsh-runtime-mapping-for-pstack).
