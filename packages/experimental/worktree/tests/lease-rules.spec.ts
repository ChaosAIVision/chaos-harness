import { describe, expect, it } from 'vitest'
import { classify, decide, decideOrphan, formatKept, isLeaseBranch, isReservedName, parseLeaseFile, parseStatus, parseWorktreeList, reapAction, stashedFrom } from '../src/lease.ts'
import type { Inspection, LeaseFile } from '../src/lease.ts'

const file: LeaseFile = {
  v: 1, state: 'held', branch: 'dsh/lease/a', ownerSession: 's', ownerHost: 'h1', ownerPid: 10, ownerStart: 'T0',
  baseCommit: 'b'.repeat(40), baseLabel: 'HEAD', createdAtMs: 1,
}

describe('classify', () => {
  it.each([
    ['no metadata', undefined, 'h1', true, 'unowned'],
    ['kept', { ...file, state: 'kept' }, 'h1', false, 'kept'],
    ['kept on another host', { ...file, state: 'kept' }, 'h2', false, 'kept'],
    ['other host, pid unknown to us', file, 'h2', false, 'foreign'],
    ['other host, pid happens to exist here', file, 'h2', true, 'foreign'],
    ['same host, alive', file, 'h1', true, 'live'],
    ['same host, dead or recycled pid', file, 'h1', false, 'dead'],
    ['provisioning, dead', { ...file, state: 'provisioning' }, 'h1', false, 'dead'],
    ['settling, alive', { ...file, state: 'settling' }, 'h1', true, 'live'],
  ] as const)('%s', (_name, input, host, alive, expected) => {
    expect(classify(input, host, alive)).toBe(expected)
  })
})

describe('reapAction', () => {
  it.each([
    ['dead', 'held', 'settle'],
    ['dead', 'settling', 'settle'],
    ['dead', 'provisioning', 'replay-provisioning'],
    ['dead', 'kept', 'settle'],
    ['live', 'held', 'skip'],
    ['foreign', 'held', 'skip'],
    ['kept', 'kept', 'skip'],
    ['unowned', undefined, 'skip'],
    ['missing', 'held', 'skip'],
  ] as const)('%s %s -> %s', (status, state, expected) => {
    expect(reapAction(status, state)).toBe(expected)
  })
})

describe('decide', () => {
  const base = 'b'.repeat(40)
  const clean: Inspection = { dirty: false, ignored: false, stashed: false, head: base, symbolicRef: 'refs/heads/dsh/lease/a', branchTip: base }
  const lease = { branch: 'dsh/lease/a', baseCommit: base }
  it.each([
    ['clean at base', clean, 'remove'],
    ['dirty', { ...clean, dirty: true }, 'keep'],
    ['ignored files', { ...clean, ignored: true }, 'keep'],
    ['stash entry', { ...clean, stashed: true }, 'keep'],
    ['new commit', { ...clean, head: 'c'.repeat(40), branchTip: 'c'.repeat(40) }, 'keep'],
    ['detached HEAD', { ...clean, symbolicRef: undefined }, 'keep'],
    ['switched branch', { ...clean, symbolicRef: 'refs/heads/other' }, 'keep'],
    ['branch moved under a clean HEAD', { ...clean, branchTip: 'c'.repeat(40) }, 'keep'],
    ['branch deleted', { ...clean, branchTip: undefined }, 'keep'],
    ['head reset elsewhere', { ...clean, head: 'c'.repeat(40) }, 'keep'],
  ] as const)('%s -> %s', (_name, inspection, action) => {
    expect(decide(inspection, lease).action).toBe(action)
  })
})

describe('decideOrphan', () => {
  it.each([
    ['tip equals creation commit', 'a', 'a', 'delete'],
    ['branch advanced', 'b', 'a', 'keep'],
    ['no reflog', 'a', undefined, 'keep'],
  ] as const)('%s', (_name, tip, created, expected) => {
    expect(decideOrphan(tip, created)).toBe(expected)
  })
})

describe('parseLeaseFile', () => {
  it('round-trips a valid record', () => {
    expect(parseLeaseFile(JSON.stringify(file))).toEqual(file)
    expect(parseLeaseFile(JSON.stringify({ ...file, ownerStart: null }))?.ownerStart).toBeNull()
    expect(parseLeaseFile(JSON.stringify({ ...file, baseCommit: 'a'.repeat(64) }))?.baseCommit).toBe('a'.repeat(64))
  })
  it.each([
    ['not json', '{'],
    ['not an object', 'null'],
    ['wrong version', JSON.stringify({ ...file, v: 2 })],
    ['unknown state', JSON.stringify({ ...file, state: 'done' })],
    ['non-string state', JSON.stringify({ ...file, state: 1 })],
    ['missing branch', JSON.stringify({ ...file, branch: undefined })],
    ['bad base', JSON.stringify({ ...file, baseCommit: 3 })],
    ['option-shaped base', JSON.stringify({ ...file, baseCommit: '--hard' })],
    ['abbreviated base', JSON.stringify({ ...file, baseCommit: 'abc1234' })],
    ['symbolic base', JSON.stringify({ ...file, baseCommit: 'HEAD' })],
    ['uppercase base', JSON.stringify({ ...file, baseCommit: 'B'.repeat(40) })],
    ['branch outside the lease namespace', JSON.stringify({ ...file, branch: 'main' })],
    ['option-shaped branch', JSON.stringify({ ...file, branch: '--force' })],
    ['branch with a traversal segment', JSON.stringify({ ...file, branch: 'dsh/lease/../main' })],
    ['branch with a space', JSON.stringify({ ...file, branch: 'dsh/lease/a b' })],
    ['bare namespace', JSON.stringify({ ...file, branch: 'dsh/lease/' })],
    ['bad pid', JSON.stringify({ ...file, ownerPid: 1.5 })],
    ['bad time', JSON.stringify({ ...file, createdAtMs: 'x' })],
    ['bad start', JSON.stringify({ ...file, ownerStart: 4 })],
  ])('rejects %s', (_name, text) => {
    expect(parseLeaseFile(text)).toBeUndefined()
  })
})

describe('parseWorktreeList', () => {
  it('reads paths, branches, and prunable markers from NUL-delimited records', () => {
    const output = [
      'worktree /repo', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /repo/.agents/worktrees/dsh/lease/x y', 'HEAD bbb', 'branch refs/heads/dsh/lease/x', 'prunable gitdir file points to non-existent location', '',
      'worktree /detached', 'HEAD ccc', 'detached', '', '',
    ].join('\0')
    expect(parseWorktreeList(output)).toEqual([
      { path: '/repo', branch: 'main', prunable: false },
      { path: '/repo/.agents/worktrees/dsh/lease/x y', branch: 'dsh/lease/x', prunable: true },
      { path: '/detached', branch: undefined, prunable: false },
    ])
    expect(parseWorktreeList('')).toEqual([])
  })
})

it('recognises only the reserved prefix', () => {
  expect(isLeaseBranch('dsh/lease/a')).toBe(true)
  expect(isLeaseBranch('dsh/leases')).toBe(false)
  expect(isLeaseBranch('feature')).toBe(false)
})

it('formats a kept report with abbreviated commits', () => {
  expect(formatKept({
    path: '/r/.agents/worktrees/dsh/lease/a', branch: 'dsh/lease/a', baseCommit: '1234567890', headCommit: 'abcdefabcdef',
    uncommitted: true, reason: 'changed',
  })).toBe('Worktree kept (changed): path=/r/.agents/worktrees/dsh/lease/a branch=dsh/lease/a base=1234567 head=abcdefa uncommitted=true')
})

describe('parseStatus', () => {
  it.each([
    ['empty', '', { dirty: false, ignored: false }],
    ['untracked', '?? a.txt\0', { dirty: true, ignored: false }],
    ['ignored secret', '!! .env\0', { dirty: false, ignored: true }],
    ['root node_modules', '!! node_modules/\0', { dirty: false, ignored: false }],
    ['nested node_modules', '!! sub/node_modules/\0', { dirty: false, ignored: false }],
    ['look-alike directory', '!! node_modules_old/\0', { dirty: false, ignored: true }],
    ['both', '!! node_modules/\0!! .env\0 M tracked.txt\0', { dirty: true, ignored: true }],
  ] as const)('%s', (_name, output, expected) => {
    expect(parseStatus(output)).toEqual(expected)
  })
})

describe('stashedFrom', () => {
  it('matches only entries made on the lease branch', () => {
    const subjects = 'WIP on main: abc subject\nOn dsh/lease/a: named\nWIP on dsh/lease/ab: x'
    expect(stashedFrom(subjects, 'dsh/lease/a')).toBe(true)
    expect(stashedFrom('WIP on dsh/lease/ab: x', 'dsh/lease/a')).toBe(false)
    expect(stashedFrom('', 'dsh/lease/a')).toBe(false)
  })
})

describe('isReservedName', () => {
  it.each([
    ['dsh', true], ['dsh/lease', true], ['dsh/lease/x', true], ['dsh/lease/x/y', true],
    ['dsh/other', false], ['dsh-lease', false], ['dsh/leases', false], ['topic', false],
  ] as const)('%s -> %s', (name, expected) => {
    expect(isReservedName(name)).toBe(expected)
  })
})
