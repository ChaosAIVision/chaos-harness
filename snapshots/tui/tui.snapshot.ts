/** Built terminal replay of a borrowed Session through the shipped tui profile. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parseSnapshotManifest } from '../../packages/test-support/session-snapshot/src/manifest.ts'

const root = resolve(import.meta.dirname, '../..')
const scenario = resolve(import.meta.dirname, 'resume-messages')

it.skipIf(process.platform === 'win32')('tui resumes the recorded messages Session without credentials', async () => {
  const manifest = parseSnapshotManifest(await readFile(resolve(scenario, 'snapshot.yml'), 'utf8'))
  expect(manifest.profile).toBe('tui')
  expect(manifest.session).toBeDefined()
  const buildRoot = process.env.DSH_TUI_TEST_BUILD_ROOT ?? root
  const result = await promisify(execFile)('python3', [
    resolve(import.meta.dirname, 'terminal-replay.py'),
    process.execPath,
    resolve(buildRoot, 'apps/cli/lib/bin.js'),
    resolve(scenario, manifest.session!.source),
    resolve(scenario, 'terminal.expected.txt'),
  ], { timeout: 100_000, maxBuffer: 1_000_000 })
  expect(result.stdout.trim()).toBe('Recorded terminal Session replay passed')
})
