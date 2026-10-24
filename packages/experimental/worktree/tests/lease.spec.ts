import { writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Config, IsolateRequest, KeptReport } from '../src/index.ts'
import { contents, filterCommand, git, harness, repository, testAgent } from './harness.ts'

let ctx: Context | undefined
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx?.fiber.dispose()
  ctx = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const root = await repository()
  roots.push(root)
  return root
}

async function start(root: string, config: Config = {}): Promise<{ ctx: Context; agent: ReturnType<typeof testAgent> }> {
  ctx = await harness(root, config)
  return { ctx, agent: testAgent(ctx, root) }
}

/** Run one delegate that applies `edit` in its directory and stops. */
async function delegate(
  context: Context,
  agent: ReturnType<typeof testAgent>,
  edit?: (cwd: string) => Promise<void>,
  request: IsolateRequest = {},
) {
  const kept: KeptReport[] = []
  const started: string[] = []
  const isolated = await context.worktrees.isolate(agent, request, async (cwd) => {
    started.push(cwd)
    await edit?.(cwd)
    return { result: Promise.resolve('done'), dispose: async () => {} }
  }, report => kept.push(report))
  const settlement = await isolated.settled
  return { isolated, settlement, kept, started }
}

const branches = (root: string) => git(root, 'branch', '--list', 'dsh/lease/*')
const worktreeCount = async (root: string) => (await git(root, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length

describe('isolating a delegate in a private worktree', () => {
  it('removes an untouched checkout and its branch, leaving the caller directory alone', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const baseCommit = await git(root, 'rev-parse', 'HEAD')
    const { isolated, settlement, kept, started } = await delegate(ctx, agent, async (cwd) => {
      expect(await git(cwd, 'rev-parse', 'HEAD')).toBe(baseCommit)
      expect(await contents(join(cwd, 'tracked.txt'))).toBe('initial\n')
    })
    if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
    expect(isolated.isolation.path).toBe(join(root, '.agents/worktrees', isolated.isolation.branch))
    expect(isolated.isolation.branch).toMatch(/^dsh\/lease\/[0-9a-f]{12}$/)
    expect(isolated.isolation.baseLabel).toBe('HEAD (no origin/HEAD)')
    expect(started).toEqual([isolated.isolation.path])
    expect(settlement).toEqual({ kind: 'removed', branch: isolated.isolation.branch })
    expect(kept).toEqual([])
    await expect(readFile(join(isolated.isolation.path, 'tracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await branches(root)).toBe('')
    expect(await worktreeCount(root)).toBe(1)
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    expect(await ctx.worktrees.list(agent)).toEqual([])
  })

  it('keeps a checkout with an untracked file and reports it', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const { isolated, settlement, kept } = await delegate(ctx, agent, cwd => writeFile(join(cwd, 'new.txt'), 'x\n'))
    if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
    const base = await git(root, 'rev-parse', 'HEAD')
    const expected = {
      kind: 'kept', path: isolated.isolation.path, branch: isolated.isolation.branch,
      baseCommit: base, headCommit: base, uncommitted: true, reason: 'changed',
    }
    expect(settlement).toEqual(expected)
    const { kind: _kind, ...report } = expected
    expect(kept).toEqual([report])
    expect(await contents(join(isolated.isolation.path, 'new.txt'))).toBe('x\n')
    expect(await branches(root)).toContain(isolated.isolation.branch)
    expect(await ctx.worktrees.list(agent)).toEqual([expect.objectContaining({ branch: isolated.isolation.branch, status: 'kept' })])
  })

  it('keeps a modified tracked file and a staged change', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const modified = await delegate(ctx, agent, cwd => writeFile(join(cwd, 'tracked.txt'), 'edited\n'))
    const staged = await delegate(ctx, agent, async (cwd) => {
      await writeFile(join(cwd, 'tracked.txt'), 'staged\n')
      await git(cwd, 'add', 'tracked.txt')
    })
    expect(modified.settlement).toMatchObject({ kind: 'kept', uncommitted: true })
    expect(staged.settlement).toMatchObject({ kind: 'kept', uncommitted: true })
  })

  it('keeps a checkout whose branch gained a commit and never deletes that branch', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const base = await git(root, 'rev-parse', 'HEAD')
    const { isolated, settlement, kept } = await delegate(ctx, agent, async (cwd) => {
      await writeFile(join(cwd, 'tracked.txt'), 'committed\n')
      await git(cwd, 'commit', '-am', 'delegate work')
    })
    if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
    const head = await git(isolated.isolation.path, 'rev-parse', 'HEAD')
    expect(head).not.toBe(base)
    expect(settlement).toMatchObject({ kind: 'kept', baseCommit: base, headCommit: head, uncommitted: false, reason: 'changed' })
    expect(kept).toHaveLength(1)
    expect(await git(root, 'rev-parse', isolated.isolation.branch)).toBe(head)
  })

  it('keeps a checkout whose HEAD was detached without commits', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const { settlement } = await delegate(ctx, agent, cwd => git(cwd, 'checkout', '--detach').then(() => undefined))
    expect(settlement).toMatchObject({ kind: 'kept', uncommitted: false, reason: 'changed' })
  })

  describe('ignored files', () => {
    async function ignoring(patterns: string): Promise<string> {
      const root = await repo()
      await writeFile(join(root, '.gitignore'), patterns)
      await git(root, 'add', '.gitignore')
      await git(root, 'commit', '-m', 'ignore')
      return root
    }

    it('keeps a checkout holding an ignored secrets file', async () => {
      const root = await ignoring('.env\n')
      const { ctx, agent } = await start(root)
      const { isolated, settlement } = await delegate(ctx, agent, cwd => writeFile(join(cwd, '.env'), 'TOKEN=1\n'))
      if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
      expect(settlement).toMatchObject({ kind: 'kept', reason: 'changed', uncommitted: true })
      expect(await contents(join(isolated.isolation.path, '.env'))).toBe('TOKEN=1\n')
      expect(await branches(root)).toContain(isolated.isolation.branch)
    })

    it('keeps a checkout holding an ignored output directory', async () => {
      const root = await ignoring('out/\n')
      const { ctx, agent } = await start(root)
      const { isolated, settlement } = await delegate(ctx, agent, async (cwd) => {
        await mkdir(join(cwd, 'out'))
        await writeFile(join(cwd, 'out/artifact.bin'), 'built')
      })
      if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
      expect(settlement).toMatchObject({ kind: 'kept', reason: 'changed' })
      expect(await contents(join(isolated.isolation.path, 'out/artifact.bin'))).toBe('built')
    })

    it('removes a checkout whose only ignored content is node_modules', async () => {
      const root = await ignoring('node_modules/\n')
      const { ctx, agent } = await start(root)
      const { isolated, settlement } = await delegate(ctx, agent, async (cwd) => {
        await mkdir(join(cwd, 'node_modules/pkg'), { recursive: true })
        await writeFile(join(cwd, 'node_modules/pkg/index.js'), 'x')
      })
      expect(settlement).toMatchObject({ kind: 'removed' })
      if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
      await expect(readdir(isolated.isolation.path)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('keeps a checkout when node_modules sits next to another ignored file', async () => {
      const root = await ignoring('node_modules/\n.env\n')
      const { ctx, agent } = await start(root)
      const { settlement } = await delegate(ctx, agent, async (cwd) => {
        await mkdir(join(cwd, 'node_modules'))
        await writeFile(join(cwd, 'node_modules/a.js'), 'x')
        await writeFile(join(cwd, '.env'), 'x')
      })
      expect(settlement).toMatchObject({ kind: 'kept' })
    })
  })

  it('keeps a checkout whose work was stashed into the shared stash ref', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const { isolated, settlement } = await delegate(ctx, agent, async (cwd) => {
      await writeFile(join(cwd, 'tracked.txt'), 'stashed work\n')
      await git(cwd, 'stash')
    })
    if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
    expect(await git(root, 'stash', 'list')).toContain(isolated.isolation.branch)
    expect(settlement).toMatchObject({ kind: 'kept', reason: 'changed' })
    expect(await contents(join(isolated.isolation.path, 'tracked.txt'))).toBe('initial\n')
  })

  it('settles when the delegate fails, and an untouched failure leaves nothing behind', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const isolated = await ctx.worktrees.isolate(agent, {}, async () => ({
      result: Promise.reject(new Error('child crashed')), dispose: async () => {},
    }), () => {})
    expect(await isolated.settled).toMatchObject({ kind: 'removed' })
    expect(await branches(root)).toBe('')
  })

  it('starts the delegate at the same offset inside the checkout as the caller has inside the repository', async () => {
    const root = await repo()
    await mkdir(join(root, 'packages/app'), { recursive: true })
    await writeFile(join(root, 'packages/app/file.txt'), 'app\n')
    await git(root, 'add', '.')
    await git(root, 'commit', '-m', 'nested')
    const { ctx, agent } = await start(root)
    const { isolated } = await delegate(ctx, agent, async (cwd) => {
      expect(await contents(join(cwd, 'file.txt'))).toBe('app\n')
    }, { cwd: 'packages/app' })
    if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
    expect(isolated.isolation.cwd).toBe(join(isolated.isolation.path, 'packages/app'))
  })

  it('rolls the lease back and rethrows when the delegate cannot start', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    await expect(ctx.worktrees.isolate(agent, {}, () => Promise.reject(new Error('no such model')), () => {})).rejects.toThrow('no such model')
    expect(await branches(root)).toBe('')
    expect(await worktreeCount(root)).toBe(1)
  })

  it('gives parallel delegates distinct checkouts and never settles a live one while sweeping', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const release = Promise.withResolvers<undefined>()
    const hold = async () => ({ result: release.promise, dispose: async () => {} })
    const first = await ctx.worktrees.isolate(agent, {}, hold, () => {})
    const second = await ctx.worktrees.isolate(agent, {}, hold, () => {})
    if (first.isolation.kind !== 'worktree' || second.isolation.kind !== 'worktree') throw new Error('expected worktrees')
    expect(first.isolation.path).not.toBe(second.isolation.path)
    expect(first.isolation.branch).not.toBe(second.isolation.branch)
    expect(await ctx.worktrees.reap(agent)).toEqual([])
    expect(await ctx.worktrees.list(agent)).toHaveLength(2)
    expect((await ctx.worktrees.list(agent)).map(lease => lease.status)).toEqual(['live', 'live'])
    release.resolve(undefined)
    expect([await first.settled, await second.settled]).toEqual([
      { kind: 'removed', branch: first.isolation.branch }, { kind: 'removed', branch: second.isolation.branch },
    ])
  })

  it('runs in the caller directory outside a Git work tree and says why', async () => {
    const plain = await realpathTemp()
    const { ctx, agent } = await start(plain)
    const { isolated, settlement, started } = await delegate(ctx, agent)
    expect(isolated.isolation).toEqual({ kind: 'degraded', cwd: plain, reason: `${plain} is not inside a Git work tree` })
    expect(settlement).toBeUndefined()
    expect(started).toEqual([plain])
    expect(await ctx.worktrees.reap(agent)).toEqual([])
    expect(await ctx.worktrees.list(agent)).toEqual([])
  })

  it('runs in place in a repository without commits', async () => {
    const root = await realpathTemp()
    await git(root, 'init', '-b', 'main')
    const { ctx, agent } = await start(root)
    const { isolated } = await delegate(ctx, agent)
    expect(isolated.isolation).toEqual({ kind: 'degraded', cwd: root, reason: `${root} has no commits` })
  })

  it('reports Git failures other than "not a repository" instead of degrading', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root, { gitCommand: process.execPath })
    const idle = async () => ({ result: Promise.resolve(), dispose: async () => {} })
    await expect(ctx.worktrees.isolate(agent, {}, idle, () => {})).rejects.toThrow(/worktree command failed/)
  })
})

describe('choosing the base commit', () => {
  async function cloneWithRemote(): Promise<{ clone: string; remoteHead: string; localHead: string }> {
    const origin = await repo()
    const remoteHead = await git(origin, 'rev-parse', 'HEAD')
    const parent = await realpathTemp()
    const clone = join(parent, 'clone')
    await git(parent, 'clone', origin, 'clone')
    await git(clone, 'config', 'user.name', 'Fixture')
    await git(clone, 'config', 'user.email', 'fixture@example.invalid')
    await git(clone, 'config', 'commit.gpgSign', 'false')
    await writeFile(join(clone, 'ahead.txt'), 'local\n')
    await git(clone, 'add', 'ahead.txt')
    await git(clone, 'commit', '-m', 'local only')
    return { clone, remoteHead, localHead: await git(clone, 'rev-parse', 'HEAD') }
  }

  it('starts from the local origin/HEAD target by default while local HEAD is ahead', async () => {
    const { clone, remoteHead, localHead } = await cloneWithRemote()
    const { ctx, agent } = await start(clone)
    const { isolated } = await delegate(ctx, agent)
    expect(isolated.isolation).toMatchObject({ kind: 'worktree', baseCommit: remoteHead, baseLabel: 'origin/main' })
    expect(remoteHead).not.toBe(localHead)
  })

  it('starts from HEAD when configured', async () => {
    const { clone, localHead } = await cloneWithRemote()
    const { ctx, agent } = await start(clone, { baseRef: 'head' })
    const { isolated } = await delegate(ctx, agent)
    expect(isolated.isolation).toMatchObject({ kind: 'worktree', baseCommit: localHead, baseLabel: 'HEAD' })
  })

  it('falls back to HEAD and says so when origin/HEAD does not resolve', async () => {
    const { clone, localHead } = await cloneWithRemote()
    await git(clone, 'update-ref', '-d', 'refs/remotes/origin/main')
    const { ctx, agent } = await start(clone)
    const { isolated } = await delegate(ctx, agent)
    expect(isolated.isolation).toMatchObject({ kind: 'worktree', baseCommit: localHead, baseLabel: 'HEAD (no origin/HEAD)' })
  })
})

describe('reserved lease namespace', () => {
  it('refuses explicit and generated names inside it', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    await expect(ctx.worktrees.create(agent, { name: 'dsh/lease/mine' })).rejects.toThrow(/reserved dsh\/lease\//)
    expect(ctx.workingDirectory.get(agent.session)).toBe(root)
    await ctx.fiber.dispose()
    await expect(harness(root, { namePrefix: 'dsh/lease/' })).rejects.toThrow(/reserved dsh\/lease\//)
  })

  it('still creates retained worktrees that move the caller directory', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const created = await ctx.worktrees.create(agent, { name: 'topic' })
    expect(ctx.workingDirectory.get(agent.session)).toBe(created.path)
    expect(await ctx.worktrees.list(agent)).toEqual([])
  })
})

describe('hooks and filter drivers during leases', () => {
  it('never runs a configured filter while provisioning, inspecting, or removing a lease', async () => {
    const root = await repo()
    await writeFile(join(root, '.gitattributes'), '*.txt filter=configured -text\n')
    await git(root, 'add', '.gitattributes')
    await git(root, 'commit', '-m', 'attributes')
    const { command, marker } = await filterCommand(root)
    await git(root, 'config', 'filter.configured.clean', command)
    await git(root, 'config', 'filter.configured.smudge', command)
    await git(root, 'config', 'filter.configured.required', 'true')
    const { ctx, agent } = await start(root)
    const { settlement } = await delegate(ctx, agent)
    expect(settlement).toMatchObject({ kind: 'removed' })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    const dirty = await delegate(ctx, agent, cwd => writeFile(join(cwd, 'tracked.txt'), 'changed\n'))
    expect(dirty.settlement).toMatchObject({ kind: 'kept', uncommitted: true })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not run repository hooks', async () => {
    const root = await repo()
    const marker = join(root, 'hook-ran')
    await mkdir(join(root, '.git/hooks'), { recursive: true })
    for (const hook of ['post-checkout', 'reference-transaction']) {
      await writeFile(join(root, '.git/hooks', hook), `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 })
    }
    const { ctx, agent } = await start(root)
    await delegate(ctx, agent)
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('failures while provisioning and sweeping', () => {
  const spawnFailing = (context: Context, matches: (argv: readonly string[]) => boolean, times = Infinity) => {
    const spawn = context.subprocess.spawn.bind(context.subprocess)
    let remaining = times
    vi.spyOn(context.subprocess, 'spawn').mockImplementation((spec) => {
      if (remaining > 0 && matches(spec.argv)) {
        remaining--
        throw new Error('injected spawn failure')
      }
      return spawn(spec)
    })
  }
  const idle = async () => ({ result: Promise.resolve(), dispose: async () => {} })

  it('finishes and removes a half-built lease when checkout fails after the worktree was registered', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    spawnFailing(ctx, argv => argv.includes('reset') && argv.includes('--hard') && !argv.includes('lease-retry'), 1)
    await expect(ctx.worktrees.isolate(agent, {}, idle, () => {})).rejects.toThrow('injected spawn failure')
    expect(await branches(root)).toBe('')
    expect(await worktreeCount(root)).toBe(1)
  })

  it('leaves a half-built lease for the reaper when rolling it back also fails', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    spawnFailing(ctx, argv => argv.includes('reset') && argv.includes('--hard'))
    await expect(ctx.worktrees.isolate(agent, {}, idle, () => {})).rejects.toThrow('injected spawn failure')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be rolled back'))
    expect(await ctx.worktrees.list(agent)).toEqual([expect.objectContaining({ status: 'live' })])
  })

  it('ignores a half-built lease that never received metadata', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    spawnFailing(ctx, argv => argv.some(arg => arg.includes('dsh-lease.json')))
    await expect(ctx.worktrees.isolate(agent, {}, idle, () => {})).rejects.toThrow('injected spawn failure')
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('rolled back'))
    expect(await ctx.worktrees.list(agent)).toEqual([expect.objectContaining({ status: 'unowned' })])
  })

  it('still provisions when the opening sweep fails', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    spawnFailing(ctx, argv => argv.includes('list'), 1)
    const { settled } = await ctx.worktrees.isolate(agent, {}, idle, () => {})
    expect(await settled).toMatchObject({ kind: 'removed' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed'))
  })

  it('reports Git failures other than "not a repository" instead of degrading', async () => {
    const root = await repo()
    await writeFile(join(root, '.git/config'), '[broken\n')
    const { ctx, agent } = await start(root)
    await expect(ctx.worktrees.isolate(agent, {}, idle, () => {})).rejects.toThrow(/worktree command failed \(128\)/)
  })

  it('keeps a checkout whose branch ref the delegate deleted', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const { settlement } = await delegate(ctx, agent, async (cwd) => {
      await git(cwd, 'update-ref', '-d', `refs/heads/${await git(cwd, 'symbolic-ref', '--short', 'HEAD')}`)
    })
    expect(settlement).toMatchObject({ kind: 'kept', reason: 'changed' })
  })

  it('honours a caller signal and refuses once it aborted', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const live = new AbortController()
    const isolated = await ctx.worktrees.isolate(agent, {}, idle, () => {}, live.signal)
    expect(await isolated.settled).toMatchObject({ kind: 'removed' })
    expect(await ctx.worktrees.list(agent, live.signal)).toEqual([])
    expect(await ctx.worktrees.reap(agent, live.signal)).toEqual([])
    live.abort(new Error('cancelled'))
    await expect(ctx.worktrees.isolate(agent, {}, idle, () => {}, live.signal)).rejects.toThrow('cancelled')
    await expect(ctx.worktrees.list(agent, live.signal)).rejects.toThrow('cancelled')
    await expect(ctx.worktrees.reap(agent, live.signal)).rejects.toThrow('cancelled')
  })
})

describe('settlement races and refusals', () => {
  it('keeps the checkout when Git refuses to remove a locked worktree', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const { settlement, isolated } = await delegate(ctx, agent, async (cwd) => {
      await git(cwd, 'worktree', 'lock', cwd)
    })
    if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
    expect(settlement).toMatchObject({ kind: 'kept', reason: 'removal-refused', uncommitted: false })
    expect(await branches(root)).toContain(isolated.isolation.branch)
  })

  it('keeps the checkout when a file appears after inspection and before removal', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      const isRemoval = spec.argv.includes('worktree') && spec.argv.includes('remove')
      if (isRemoval) {
        const entry = spec.argv.at(-1)
        if (entry === undefined) throw new Error('removal has no path')
        writeFileSync(join(entry, 'late.txt'), 'late\n')
      }
      return spawn(spec)
    })
    const { settlement, isolated } = await delegate(ctx, agent)
    if (isolated.isolation.kind !== 'worktree') throw new Error('expected a worktree')
    expect(settlement).toMatchObject({ kind: 'kept', reason: 'changed-during-removal', uncommitted: true })
    expect(await contents(join(isolated.isolation.path, 'late.txt'))).toBe('late\n')
    expect(await branches(root)).toContain(isolated.isolation.branch)
  })

  it('logs and survives a failing kept-report callback', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const isolated = await ctx.worktrees.isolate(agent, {}, async (cwd) => {
      await writeFile(join(cwd, 'x.txt'), 'x')
      return { result: Promise.resolve(), dispose: async () => {} }
    }, () => { throw new Error('inbox closed') })
    expect(await isolated.settled).toMatchObject({ kind: 'kept' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('inbox closed'))
  })

  it('reports an unsettled lease through the log and leaves it for a later sweep', async () => {
    const root = await repo()
    const { ctx, agent } = await start(root)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const isolated = await ctx.worktrees.isolate(agent, {}, async (cwd) => {
      await rm(join(cwd, '.git'))
      return { result: Promise.resolve(), dispose: async () => {} }
    }, () => {})
    expect(await isolated.settled).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was not settled'))
  })
})

async function realpathTemp(): Promise<string> {
  const path = await repository(tmpdir()).then(async (made) => {
    await rm(made, { recursive: true, force: true })
    await mkdir(made)
    return made
  })
  roots.push(path)
  return path
}
