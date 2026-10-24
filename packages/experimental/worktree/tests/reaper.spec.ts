import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Isolation, KeptReport } from '../src/index.ts'
import { git, harness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
const roots: string[] = []
const children: Array<{ kill: (signal: NodeJS.Signals) => boolean }> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/lease-then-hang.ts', import.meta.url))

async function repo(): Promise<string> {
  const root = await repository()
  roots.push(root)
  return root
}

/** Start the fixture under tsx, the declared source launcher, and wait for the lease it provisions. */
async function crashable(root: string, mode: 'clean' | 'dirty', session: string) {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', fixture, root, mode, session], {
    cwd: repositoryRoot,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(repositoryRoot, 'tsconfig.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve()
    })
  })
  const isolation = await new Promise<Isolation>((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('\n')) resolve(JSON.parse(out) as Isolation)
    })
    child.on('exit', () => {
      reject(new Error(`fixture exited before provisioning: ${stderr}`))
    })
  })
  if (isolation.kind !== 'worktree') throw new Error('fixture did not isolate')
  return {
    isolation,
    kill: async () => {
      child.kill('SIGKILL')
      await exited
    },
  }
}

const finished = async () => ({ result: Promise.resolve() })
const hanging = async () => ({ result: new Promise<undefined>(() => {}) })

async function start(root: string, session = 'reaper') {
  ctx = await harness(root)
  return { ctx, agent: testAgent(ctx, root, session) }
}

describe('after a real SIGKILL', () => {
  it('leaves a live owner alone, then removes the clean lease once the owner is dead, idempotently', async () => {
    const root = await repo()
    const child = await crashable(root, 'clean', 'crashed')
    const { ctx, agent } = await start(root)
    expect(await ctx.worktrees.list(agent)).toEqual([expect.objectContaining({ branch: child.isolation.branch, status: 'live', ownerSession: 'crashed' })])
    expect(await ctx.worktrees.reap(agent)).toEqual([])
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toContain(child.isolation.branch)

    await child.kill()
    expect(await ctx.worktrees.list(agent)).toEqual([expect.objectContaining({ status: 'dead' })])
    expect(await ctx.worktrees.reap(agent)).toEqual([{ kind: 'removed', branch: child.isolation.branch }])
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toBe('')
    expect(await git(root, 'worktree', 'list', '--porcelain')).not.toContain(child.isolation.branch)
    expect(await ctx.worktrees.reap(agent)).toEqual([])
    expect(await ctx.worktrees.list(agent)).toEqual([])
  })

  it('keeps the dead owner\'s unsaved work, reports it to the same Session at its next isolate, and never reaps it twice', async () => {
    const root = await repo()
    const child = await crashable(root, 'dirty', 'owner-session')
    await child.kill()
    const { ctx, agent } = await start(root, 'owner-session')
    const kept: KeptReport[] = []
    const next = await ctx.worktrees.isolate(agent, {}, finished, report => kept.push(report))
    await next.settled
    expect(kept).toEqual([expect.objectContaining({
      path: child.isolation.path, branch: child.isolation.branch, uncommitted: true, reason: 'changed',
    })])
    expect(await readFile(join(child.isolation.path, 'unsaved.txt'), 'utf8')).toBe('work in progress\n')
    expect(await ctx.worktrees.list(agent)).toEqual([expect.objectContaining({ branch: child.isolation.branch, status: 'kept' })])
    expect(await ctx.worktrees.reap(agent)).toEqual([])
    expect(await readFile(join(child.isolation.path, 'unsaved.txt'), 'utf8')).toBe('work in progress\n')
  })

  it('does not report another Session\'s kept lease to the caller', async () => {
    const root = await repo()
    const child = await crashable(root, 'dirty', 'someone-else')
    await child.kill()
    const { ctx, agent } = await start(root, 'unrelated')
    const kept: KeptReport[] = []
    const next = await ctx.worktrees.isolate(agent, {}, finished, report => kept.push(report))
    await next.settled
    expect(kept).toEqual([])
    expect(await ctx.worktrees.list(agent)).toEqual([expect.objectContaining({ branch: child.isolation.branch, status: 'kept' })])
  })
})

/** Rewrite the metadata of the single lease in a repository to simulate another owner. */
async function rewriteOwner(root: string, branch: string, change: Record<string, unknown>): Promise<void> {
  const path = join(root, '.agents/worktrees', branch)
  const file = join(await git(path, 'rev-parse', '--absolute-git-dir'), 'dsh-lease.json')
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')) as object, ...change }))
}

async function heldLease(root: string): Promise<{ branch: string; path: string }> {
  const { ctx, agent } = await start(root)
  const isolated = await ctx.worktrees.isolate(agent, {}, hanging, () => {})
  if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
  return { branch: isolated.isolation.branch, path: isolated.isolation.path }
}

describe('ownership', () => {
  it('skips leases owned by another host, however dead their pid looks', async () => {
    const root = await repo()
    const lease = await heldLease(root)
    await rewriteOwner(root, lease.branch, { ownerHost: 'another-machine', ownerPid: 2_147_483_000 })
    const agent = testAgent(ctx!, root, 'sweeper')
    expect(await ctx!.worktrees.list(agent)).toEqual([expect.objectContaining({ status: 'foreign' })])
    expect(await ctx!.worktrees.reap(agent)).toEqual([])
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toContain(lease.branch)
  })

  it('treats a live pid with a different start time as a recycled pid and reaps', async () => {
    const root = await repo()
    const lease = await heldLease(root)
    await rewriteOwner(root, lease.branch, { ownerStart: 'Mon Jan  1 00:00:00 1990' })
    const agent = testAgent(ctx!, root, 'sweeper')
    expect(await ctx!.worktrees.reap(agent)).toEqual([{ kind: 'removed', branch: lease.branch }])
  })

  it('never reaps a lease whose owner start time cannot be compared', async () => {
    const root = await repo()
    const lease = await heldLease(root)
    await rewriteOwner(root, lease.branch, { ownerStart: null })
    const agent = testAgent(ctx!, root, 'sweeper')
    expect(await ctx!.worktrees.reap(agent)).toEqual([])
    expect(await ctx!.worktrees.list(agent)).toEqual([expect.objectContaining({ status: 'live' })])
  })

  it('never removes a worktree whose metadata is missing or unreadable', async () => {
    const root = await repo()
    const lease = await heldLease(root)
    const file = join(await git(lease.path, 'rev-parse', '--absolute-git-dir'), 'dsh-lease.json')
    const agent = testAgent(ctx!, root, 'sweeper')
    await writeFile(file, '{ truncated')
    expect(await ctx!.worktrees.list(agent)).toEqual([expect.objectContaining({ status: 'unowned' })])
    expect(await ctx!.worktrees.reap(agent)).toEqual([])
    await rm(file)
    expect(await ctx!.worktrees.reap(agent)).toEqual([])
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toContain(lease.branch)
  })

  it('reports a lease whose directory a human deleted as missing and leaves Git state alone', async () => {
    const root = await repo()
    const lease = await heldLease(root)
    await rm(lease.path, { recursive: true })
    const agent = testAgent(ctx!, root, 'sweeper')
    expect(await ctx!.worktrees.list(agent)).toEqual([expect.objectContaining({ status: 'missing' })])
    expect(await ctx!.worktrees.reap(agent)).toEqual([])
  })
})

describe('replaying interrupted transitions', () => {
  const dead = { ownerPid: 2_147_483_000, ownerStart: 'Mon Jan  1 00:00:00 1990' }

  async function manualLease(root: string, branch: string, state: 'provisioning' | 'held' | 'settling', checkout: boolean): Promise<string> {
    const base = await git(root, 'rev-parse', 'HEAD')
    const path = join(root, '.agents/worktrees', branch)
    await mkdir(join(root, '.agents/worktrees', 'dsh/lease'), { recursive: true })
    await git(root, 'worktree', 'add', ...(checkout ? [] : ['--no-checkout']), '-b', branch, path, base)
    const file = join(await git(path, 'rev-parse', '--absolute-git-dir'), 'dsh-lease.json')
    await writeFile(file, JSON.stringify({
      v: 1, state, branch, ownerSession: 'crashed', ownerHost: (await import('node:os')).hostname(), ...dead,
      baseCommit: base, baseLabel: 'HEAD', createdAtMs: 1,
    }))
    return path
  }

  it('finishes the checkout of a lease that died while provisioning, then removes it', async () => {
    const root = await repo()
    const path = await manualLease(root, 'dsh/lease/halfbuilt', 'provisioning', false)
    const { ctx, agent } = await start(root)
    expect(await ctx.worktrees.reap(agent)).toEqual([{ kind: 'removed', branch: 'dsh/lease/halfbuilt' }])
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toBe('')
    await expect(readFile(join(path, 'tracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('completes a lease that died while settling, whether clean or changed', async () => {
    const root = await repo()
    await manualLease(root, 'dsh/lease/cleaning', 'settling', true)
    const changed = await manualLease(root, 'dsh/lease/changed', 'settling', true)
    await writeFile(join(changed, 'work.txt'), 'x')
    const { ctx, agent } = await start(root)
    const settled = await ctx.worktrees.reap(agent)
    expect(settled).toHaveLength(2)
    expect(settled).toContainEqual(expect.objectContaining({ kind: 'kept', branch: 'dsh/lease/changed', uncommitted: true }))
    expect(settled).toContainEqual({ kind: 'removed', branch: 'dsh/lease/cleaning' })
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toContain('dsh/lease/changed')
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).not.toContain('cleaning')
  })

  it('deletes a lease branch whose worktree vanished after removal, but only if it never advanced', async () => {
    const root = await repo()
    const untouched = await manualLease(root, 'dsh/lease/untouched', 'held', true)
    const advanced = await manualLease(root, 'dsh/lease/advanced', 'held', true)
    await writeFile(join(advanced, 'tracked.txt'), 'new\n')
    await git(advanced, 'commit', '-am', 'work')
    await git(root, 'worktree', 'remove', '--force', untouched)
    await git(root, 'worktree', 'remove', '--force', advanced)
    const { ctx, agent } = await start(root)
    expect(await ctx.worktrees.list(agent)).toEqual([
      expect.objectContaining({ branch: 'dsh/lease/advanced', status: 'unowned' }),
      expect.objectContaining({ branch: 'dsh/lease/untouched', status: 'unowned' }),
    ])
    expect(await ctx.worktrees.reap(agent)).toEqual([{ kind: 'removed', branch: 'dsh/lease/untouched' }])
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toContain('dsh/lease/advanced')
    expect(await ctx.worktrees.reap(agent)).toEqual([])
  })

  it('keeps an orphaned lease branch when its reflog does not show a creation entry', async () => {
    const root = await repo()
    await git(root, 'branch', '--no-track', 'dsh/lease/handmade')
    await rm(join(root, '.git/logs/refs/heads/dsh'), { recursive: true, force: true })
    const { ctx, agent } = await start(root)
    expect(await ctx.worktrees.reap(agent)).toEqual([])
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toContain('dsh/lease/handmade')
  })

  it('settles the remaining dead leases when one cannot be inspected, and never touches the broken one', async () => {
    const root = await repo()
    const broken = await manualLease(root, 'dsh/lease/broken', 'held', true)
    await manualLease(root, 'dsh/lease/fine', 'held', true)
    const adminDir = await git(broken, 'rev-parse', '--absolute-git-dir')
    await writeFile(join(adminDir, 'index'), 'not an index')
    const { ctx, agent } = await start(root)
    expect(await ctx.worktrees.reap(agent)).toEqual([{ kind: 'removed', branch: 'dsh/lease/fine' }])
    expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toContain('dsh/lease/broken')
  })

  it('keeps a lease whose worktree link is unreadable, since Git refuses to remove it', async () => {
    const root = await repo()
    const unreadable = await manualLease(root, 'dsh/lease/unlinked', 'held', true)
    await writeFile(join(unreadable, '.git'), 'gitdir: /nonexistent\n')
    const { ctx, agent } = await start(root)
    expect(await ctx.worktrees.list(agent)).toEqual([expect.objectContaining({ branch: 'dsh/lease/unlinked', status: 'dead' })])
    expect(await ctx.worktrees.reap(agent)).toEqual([expect.objectContaining({ kind: 'kept', reason: 'removal-refused' })])
    expect(await readFile(join(unreadable, 'tracked.txt'), 'utf8')).toBe('initial\n')
  })

  it('ignores a worktree link the child retargeted at a foreign directory carrying a forged lease', async () => {
    const root = await repo()
    const victim = await manualLease(root, 'dsh/lease/victim', 'held', true)
    const foreign = await repo()
    const adminDir = join(foreign, '.git')
    const foreignHead = await git(foreign, 'rev-parse', 'HEAD')
    await git(foreign, 'checkout', '-q', '-b', 'dsh/lease/victim')
    const forged = JSON.stringify({
      v: 1, state: 'held', branch: 'dsh/lease/victim', ownerSession: 'crashed', ownerHost: (await import('node:os')).hostname(), ...dead,
      baseCommit: foreignHead, baseLabel: 'HEAD', createdAtMs: 1,
    })
    await writeFile(join(adminDir, 'dsh-lease.json'), forged)
    await writeFile(join(victim, '.git'), `gitdir: ${adminDir}\n`)
    const { ctx, agent } = await start(root)
    expect(await ctx.worktrees.reap(agent)).toEqual([expect.objectContaining({ kind: 'kept', branch: 'dsh/lease/victim' })])
    expect(await readFile(join(adminDir, 'dsh-lease.json'), 'utf8')).toBe(forged)
    expect(await git(foreign, 'branch', '--show-current')).toBe('dsh/lease/victim')
    expect(await git(foreign, 'rev-parse', 'HEAD')).toBe(foreignHead)
    expect(await readFile(join(victim, 'tracked.txt'), 'utf8')).toBe('initial\n')
  })

  it('converges without error when two services sweep the same repository together', async () => {
    const root = await repo()
    await manualLease(root, 'dsh/lease/racing', 'held', true)
    const { ctx: first, agent: firstAgent } = await start(root)
    const second = await harness(root)
    try {
      const secondAgent = testAgent(second, root, 'second')
      const [a, b] = await Promise.all([first.worktrees.reap(firstAgent), second.worktrees.reap(secondAgent)])
      expect([...a, ...b]).toContainEqual({ kind: 'removed', branch: 'dsh/lease/racing' })
      expect([...a, ...b].every(settlement => settlement.kind === 'removed')).toBe(true)
      expect(await git(root, 'branch', '--list', 'dsh/lease/*')).toBe('')
      expect(await first.worktrees.reap(firstAgent)).toEqual([])
    } finally {
      await second.fiber.dispose()
    }
  })
})
