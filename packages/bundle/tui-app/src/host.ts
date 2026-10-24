/** Owned Web subprocess and explicit attachment credential-file handling. */
import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TerminalLaunch } from './launch-types.ts'
import { runtimeCopy as t } from './runtime-copy.ts'

/** Host ownership retained until terminal shutdown. */
export interface TerminalHost {
  readonly connectUrl: string
  readonly lost: AbortSignal
  stop(): Promise<void>
}

/**
 * Read a connection credential without accepting a symlink or shared file.
 * @param path - explicit credential file selected by the operator.
 * @returns the URL, never written to terminal output.
 */
export async function readConnectUrl(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || (process.getuid !== undefined && stat.uid !== process.getuid()) || stat.size > 16_384) {
      throw new Error(t.file)
    }
    return (await file.readFile('utf8')).trim()
  } finally {
    await file.close()
  }
}

/**
 * Attach without owning process lifetime, or start the same dsh executable on port zero.
 * @param launch - accepted profile invocation.
 * @param signal - terminal lifetime, including cancellation during startup.
 * @param timeoutMs - configured startup deadline.
 * @param shutdownMs - configured child shutdown grace.
 * @returns the ready Host and its ownership-specific disposer.
 */
export async function startTerminalHost(
  launch: TerminalLaunch, signal: AbortSignal, timeoutMs: number, shutdownMs: number,
): Promise<TerminalHost> {
  signal.throwIfAborted()
  if (launch.host.kind === 'attached') {
    return { connectUrl: await readConnectUrl(launch.host.connectUrlFile), lost: new AbortController().signal, stop: async () => {} }
  }
  const entry = process.argv[1]
  if (entry === undefined) throw new Error(t.launch)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-'))
  let child: ChildProcess | undefined
  let stopped: Promise<void> | undefined
  let diagnostic = ''
  const lost = new AbortController()
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      signal.removeEventListener('abort', onAbort)
      if (child !== undefined && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const owned = child
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { owned.kill('SIGKILL') }, shutdownMs)
          owned.once('exit', () => { clearTimeout(timer); resolve() })
          owned.kill('SIGTERM')
        })
      }
      await rm(directory, { recursive: true, force: true })
    })()
    return stopped
  }
  const onAbort = (): void => { void stop() }
  try {
    const watch = join(directory, 'parent-watch.mjs')
    await writeFile(watch, `
import { rmSync } from 'node:fs'
const stop = () => {
  rmSync(${JSON.stringify(directory)}, { recursive: true, force: true })
  setTimeout(() => process.exit(0), ${shutdownMs}).unref()
  process.kill(process.pid, 'SIGTERM')
}
process.once('disconnect', stop)
if (!process.connected) stop()
`, { mode: 0o600 })
    const patch = join(directory, 'host.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
      { id: 'hmr', disabled: true },
      { insert: [{ id: 'tui-host-bridge', name: '@deepseek-ai/dsh-tui-app', config: { mode: 'host-bridge' } }] },
    ]), { mode: 0o600 })
    signal.throwIfAborted()
    child = spawn(process.execPath, [...process.execArgv, '--import', pathToFileURL(watch).href, entry, '--profile', launch.host.profile, '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: launch.cwd,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const owned = child
    owned.stderr?.setEncoding('utf8')
    owned.stderr?.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-8192) })
    owned.once('exit', () => { lost.abort(new Error(t.ended)) })
    signal.addEventListener('abort', onAbort, { once: true })
    const connectUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { finish(new Error(t.ready)) }, timeoutMs)
      const aborted = (): void => { finish(new Error(t.ended)) }
      const failed = (): void => {
        const detail = redactHostDiagnostic(diagnostic)
        finish(new Error(detail === '' ? t.launch : `${t.launch}\n${detail}`))
      }
      const message = (value: unknown): void => {
        if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'tui-host-ready' && 'connectUrl' in value && typeof value.connectUrl === 'string') {
          finish(undefined, value.connectUrl)
        }
      }
      const finish = (error?: Error, url?: string): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', aborted)
        owned.off('message', message)
        owned.off('error', failed)
        owned.off('exit', failed)
        if (error !== undefined) reject(error)
        else if (url !== undefined) resolve(url)
      }
      signal.addEventListener('abort', aborted, { once: true })
      owned.on('message', message)
      owned.once('error', failed)
      owned.once('exit', failed)
      if (signal.aborted) aborted()
    })
    return { connectUrl, lost: lost.signal, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

/**
 * Bound and redact child diagnostics before restoring them to terminal output.
 * @param text - stderr tail from the privately owned subprocess.
 * @returns plain diagnostic text with URL credentials and named secrets removed.
 */
export function redactHostDiagnostic(text: string): string {
  return text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[Host URL]')
    .replace(/\bdsh-auth-[A-Za-z0-9_-]+\s*=\s*[^\s;]+/g, '[redacted auth cookie]')
    .replace(/\bv2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted auth cookie]')
    .replace(/((?:token|api[-_]?key|authorization|password|secret)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk|dsk)-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim().slice(-4096)
}
