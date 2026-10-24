/** Owned process lifetime and explicit attachment file acceptance. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readConnectUrl, redactHostDiagnostic, startTerminalHost } from '../src/host.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'tui-host-test-'))
  cleanup.push(async () => { await rm(path, { recursive: true, force: true }) })
  return path
}

describe('Terminal Host ownership', () => {
  it('redacts private URLs, named credentials, and terminal control bytes from diagnostics', () => {
    const output = redactHostDiagnostic('\x1b[31mfailed https://host/?token=private apiKey=secret-value sk-hidden\x1b[0m')
    expect(output).toContain('failed')
    expect(output).not.toMatch(/private|secret-value|sk-hidden|\x1b/)
  })

  it('accepts private regular files and rejects shared files and symlinks', async () => {
    const dir = await directory()
    const path = join(dir, 'connect')
    await writeFile(path, 'http://127.0.0.1:1234/?token=private\n', { mode: 0o600 })
    expect(await readConnectUrl(path)).toBe('http://127.0.0.1:1234/?token=private')
    await symlink(path, join(dir, 'link'))
    await expect(readConnectUrl(join(dir, 'link'))).rejects.toThrow()
    await chmod(path, 0o644)
    await expect(readConnectUrl(path)).rejects.toThrow('only by you')
  })

  it('attaches without claiming a Host process lifetime', async () => {
    const dir = await directory()
    const path = join(dir, 'connect')
    await writeFile(path, 'http://127.0.0.1:1234/?token=private', { mode: 0o600 })
    const host = await startTerminalHost({ cwd: dir, initial: { kind: 'new' }, host: { kind: 'attached', connectUrlFile: path } }, new AbortController().signal, 1000, 500)
    await host.stop()
    await host.stop()
    expect(host.lost.aborted).toBe(false)
    expect(await readFile(path, 'utf8')).toContain('token=private')
  })

  it('starts only the selected child, hands off over IPC, and waits for its shutdown', async () => {
    const dir = await directory()
    const entry = join(dir, 'fixture.mjs')
    const receipt = join(dir, 'receipt.json')
    await writeFile(entry, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }))
process.send({ kind: 'tui-host-ready', connectUrl: 'http://127.0.0.1:1234/?token=private' })
setInterval(() => {}, 1000)
`)
    const savedEntry = process.argv[1]
    const savedArgs = process.execArgv
    process.argv[1] = entry
    process.execArgv = []
    try {
      const host = await startTerminalHost({ cwd: dir, initial: { kind: 'new' }, host: { kind: 'owned', profile: 'web' } }, new AbortController().signal, 3000, 500)
      cleanup.push(() => host.stop())
      const observed = JSON.parse(await readFile(receipt, 'utf8')) as { pid: number; args: string[] }
      expect(observed.args).toContain('--no-open')
      expect(observed.args.slice(-5)).toEqual(['--host', '127.0.0.1', '--port', '0', '--no-open'])
      expect(host.connectUrl).toContain('token=private')
      const patch = observed.args[observed.args.indexOf('--patch') + 1]!
      expect(await readFile(patch, 'utf8')).toContain('"printUrl":false')
      await Promise.all([host.stop(), host.stop()])
      expect(() => process.kill(observed.pid, 0)).toThrow()
      await expect(readFile(patch)).rejects.toThrow()
      expect(host.lost.aborted).toBe(true)
    } finally {
      if (savedEntry === undefined) process.argv.splice(1, 1)
      else process.argv[1] = savedEntry
      process.execArgv = savedArgs
    }
  })

  it('stops a child when its parent dies before readiness', async () => {
    const dir = await directory()
    const entry = join(dir, 'waiting-host.mjs')
    const receipt = join(dir, 'child-pid')
    const supervisor = join(dir, 'supervisor.mjs')
    await writeFile(entry, `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(receipt)}, String(process.pid))
setInterval(() => {}, 1000)
`)
    await writeFile(supervisor, `
import { startTerminalHost } from ${JSON.stringify(new URL('../src/host.ts', import.meta.url).href)}
process.argv[1] = ${JSON.stringify(entry)}
process.execArgv = []
await startTerminalHost({ cwd: ${JSON.stringify(dir)}, initial: { kind: 'new' }, host: { kind: 'owned', profile: 'web' } }, new AbortController().signal, 10000, 500)
`)
    const parent = spawn(process.execPath, [supervisor], { stdio: 'ignore' })
    cleanup.push(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL') })
    let pid: number | undefined
    await expect.poll(async () => {
      try { pid = Number(await readFile(receipt, 'utf8')); return true } catch { return false }
    }, { timeout: 3000 }).toBe(true)
    const exited = once(parent, 'exit')
    parent.kill('SIGKILL')
    await exited
    await expect.poll(() => {
      try { process.kill(pid!, 0); return true } catch { return false }
    }, { timeout: 3000 }).toBe(false)
  })

  it('cancels a child that never announces readiness', async () => {
    const dir = await directory()
    const entry = join(dir, 'fixture.mjs')
    await writeFile(entry, 'setInterval(() => {}, 1000)')
    const savedEntry = process.argv[1]
    const savedArgs = process.execArgv
    process.argv[1] = entry
    process.execArgv = []
    try {
      await expect(startTerminalHost({ cwd: dir, initial: { kind: 'new' }, host: { kind: 'owned', profile: 'web' } }, new AbortController().signal, 50, 500)).rejects.toThrow('startup timeout')
    } finally {
      if (savedEntry === undefined) process.argv.splice(1, 1)
      else process.argv[1] = savedEntry
      process.execArgv = savedArgs
    }
  })
})
