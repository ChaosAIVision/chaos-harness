---
description: "Interactive terminal profile using the existing Harness Web Host and Client services."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-tui-app`

English | [中文](README.zh.md)

## Summary

`dsh tui` opens an interactive terminal application. Its profile contains the terminal Client only. The application starts the same `dsh` executable with the Web profile, an OS-assigned loopback port, and no browser. The Web Host owns sessions, presets, skills, settings, commands, and execution. The terminal uses the existing typed Remote API and retained Client Sessions.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

```sh
dsh tui
dsh tui --load
dsh tui --resume SESSION_ID
dsh tui --preset ptc --cwd /path/to/project
dsh tui --connect-url-file /path/to/private-connect-url
```

`--host-profile` selects a Web-compatible profile for an owned Host. `--connect-url-file` attaches to an existing Host instead. The file contains its authenticated HTTP(S) URL, must be a regular file owned by the current user, and must deny group and other access. Symlinks are rejected. Attachment never starts or stops a Host. The URL is not accepted as a command-line value or printed to the terminal.

An owned Host receives a private readiness plugin through a temporary patch. It sends its authenticated URL over inherited IPC after the Loader settles. The terminal exchanges that URL for an interactive API cookie and confines HTTP requests and WebSocket connections to the selected origin and mount. A new socket generation repeats admission. Existing Host authorization and session writer locks remain authoritative.

Closing the terminal disposes Client state, restores terminal modes, and stops only its owned Host. The child also stops when its parent dies, including during startup. The terminal profile's `startupTimeoutMs` and `shutdownTimeoutMs` configure readiness and shutdown bounds. Startup errors include a bounded, redacted child diagnostic tail.

Slash discovery includes active Host commands and invocable skills. When a name conflicts with a terminal action, `/host:NAME` and `/skill:NAME` retain explicit access to the original operation. Child history uses terminal navigation without ordinary-Agent command activation.

## Dev Note

`host.ts` owns the child process and private readiness handshake. `client.ts` loads the separate private `lib/client.js` bundle so Host and Client Context declarations stay in separate compiler programs. Its `terminalRequests` accessor carries authenticated HTTP routes that have no generated Remote method. `renderer.ts` owns transient terminal focus; retained Client Sessions own history and submission state.

## Model Experience

### Existing Web composition

#### What the model sees

The selected `--host-profile`, `--preset`, session, and commands supply model context. Terminal rendering introduces no model prompt or tool policy.

#### Token effect

No additional model tokens for the carrier or terminal renderer. Invoked commands and selected presets retain their ordinary model effects.

#### KV Cache effect

The terminal does not change request prefixes. The existing Host composition and session changes determine cache reuse.

## Known Limitations and Deferred Work

- The application requires an interactive terminal.
- Documents use text, table, and navigation views rather than browser layouts or PDF page images.
- A Host restart invalidates its launch URL; attachment requires an updated private URL file and a new terminal invocation.
- Host plugins can add browser-specific UI contributions that need a terminal presenter before those contributions are usable here.
