/** Process identity for lease ownership: host, pid, and process start time. */

import { execFile } from 'node:child_process'
import { hostname } from 'node:os'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** This machine's host name; leases recorded under another name are never reaped here. */
export const HOST = hostname()

type PsRunner = (pid: number) => Promise<string>

async function runPs(pid: number): Promise<string> {
  const { stdout } = await execute('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } })
  return stdout
}

/**
 * Read a process start time from the operating system.
 * @param pid - process id to inspect.
 * @param ps - prints the raw `ps` start timestamp for a pid; replaceable for tests.
 * @returns the `ps` start timestamp, or null when the process or `ps` is unavailable.
 */
export async function processStart(pid: number, ps: PsRunner = runPs): Promise<string | null> {
  if (process.platform === 'win32') return null
  try {
    const stdout = await ps(pid)
    const text = stdout.trim()
    return text.length === 0 ? null : text
  } catch (_exited: unknown) {
    // ps exits nonzero for an unknown pid and fails to spawn where absent; both mean "no start time".
    return null
  }
}

let ownStart: Promise<string | null> | undefined

/**
 * Identify the current process for a new lease.
 * @returns pid and start time, memoized for the process lifetime.
 */
export async function currentOwner(): Promise<{ pid: number; start: string | null }> {
  ownStart ??= processStart(process.pid)
  return { pid: process.pid, start: await ownStart }
}

/**
 * Whether a recorded owner is still the same running process.
 * Uncertainty keeps the owner alive: a missing start time on either side never proves death.
 * @param pid - recorded pid.
 * @param start - recorded start time, null when none was available.
 * @returns false only when the pid is gone or now belongs to a process with a different start time.
 */
export async function ownerAlive(pid: number, start: string | null): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch (signalError: unknown) {
    return signalError instanceof Error && 'code' in signalError && signalError.code === 'EPERM'
  }
  if (start === null) return true
  const now = await processStart(pid)
  return now === null || now === start
}
