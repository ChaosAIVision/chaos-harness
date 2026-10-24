/** Built terminal replay of a borrowed Session through the shipped tui profile. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parseSnapshotManifest } from '../../packages/test-support/session-snapshot/src/manifest.ts'
import type { Terminal } from '@xterm/headless'

const root = resolve(import.meta.dirname, '../..')
const scenario = resolve(import.meta.dirname, 'resume-messages')
const require = createRequire(import.meta.url)

async function frame(path: string): Promise<string> {
  const { Terminal: Screen } = require('@xterm/headless') as typeof import('@xterm/headless')
  const screen: Terminal = new Screen({ cols: 120, rows: 40, allowProposedApi: true })
  try {
    const bytes = await readFile(path)
    await new Promise<void>(resolve => { screen.write(bytes, resolve) })
    const buffer = screen.buffer.active
    return Array.from({ length: 40 }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n')
  } finally { screen.dispose() }
}

it.skipIf(process.platform === 'win32' || process.env.DSH_EXAMPLE_MODE !== 'lib')('tui resumes the recorded messages Session without credentials', async () => {
  const manifest = parseSnapshotManifest(await readFile(resolve(scenario, 'snapshot.yml'), 'utf8'))
  expect(manifest.profile).toBe('tui')
  expect(manifest.session).toBeDefined()
  const buildRoot = process.env.DSH_TUI_TEST_BUILD_ROOT ?? root
  const frames = await mkdtemp(resolve(tmpdir(), 'dsh-tui-frames-'))
  try {
    const result = await promisify(execFile)('python3', [
      resolve(import.meta.dirname, 'terminal-replay.py'),
      process.execPath,
      resolve(buildRoot, 'apps/cli/lib/bin.js'),
      resolve(scenario, manifest.session!.source),
      resolve(scenario, 'terminal.expected.txt'),
      frames,
    ], { timeout: 100_000, maxBuffer: 1_000_000 })
    expect(result.stdout.trim()).toBe('Recorded terminal Session replay passed')
    const chat = await frame(resolve(frames, 'chat.ansi'))
    expect(chat).toContain('MESSAGES_WEB_READY')
    expect(chat).not.toContain('Current runtime context')
    const menu = await frame(resolve(frames, 'menu.ansi'))
    expect(menu).toContain('Select a model')
    expect(menu).not.toMatch(/MESSAGES_WEB_READY|Connected ·|Context ·|Enter send/)
    const restored = await frame(resolve(frames, 'restored.ansi'))
    expect(restored).toContain('MESSAGES_WEB_READY')
    expect(restored).toContain('Connected · Ready')
    expect(restored).not.toContain('Select a model')
  } finally { await rm(frames, { recursive: true, force: true }) }
})
