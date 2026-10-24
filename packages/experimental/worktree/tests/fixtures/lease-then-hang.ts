/** Provisions one lease from a real process, reports it on stdout, and then hangs until the test kills it. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harness, testAgent } from '../harness.ts'

const [root, mode, session] = process.argv.slice(2)
if (root === undefined || session === undefined || (mode !== 'clean' && mode !== 'dirty')) throw new Error('usage: <root> clean|dirty <session>')

const ctx = await harness(root)
const agent = testAgent(ctx, root, session)
const { isolation } = await ctx.worktrees.isolate(agent, {}, async (cwd) => {
  if (mode === 'dirty') await writeFile(join(cwd, 'unsaved.txt'), 'work in progress\n')
  return { result: new Promise<undefined>(() => {}) }
}, () => {})
process.stdout.write(`${JSON.stringify(isolation)}\n`)
setInterval(() => {}, 1_000)
