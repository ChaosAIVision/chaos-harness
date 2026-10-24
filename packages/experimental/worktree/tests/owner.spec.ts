import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentOwner, ownerAlive, processStart } from '../src/owner.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('process identity', () => {
  it('reads this process start time and memoizes the owner record', async () => {
    const owner = await currentOwner()
    expect(owner.pid).toBe(process.pid)
    expect(owner.start).toBe(await processStart(process.pid))
    expect(owner.start).toMatch(/\d{4}$/)
    expect(await currentOwner()).toEqual(owner)
  })

  it.each([
    ['an unknown pid', async () => processStart(2_147_483_000), null],
    ['an empty report', async () => processStart(1, async () => '  \n'), null],
    ['a report with padding', async () => processStart(1, async () => ' Mon Jan  1 00:00:00 1990\n'), 'Mon Jan  1 00:00:00 1990'],
  ])('returns the trimmed start time or null for %s', async (_name, read, expected) => {
    expect(await read()).toBe(expected)
  })

  it('has no start time on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(await processStart(process.pid)).toBeNull()
  })

  it('judges liveness from pid and start time, treating doubt as alive', async () => {
    const own = await currentOwner()
    expect(await ownerAlive(process.pid, own.start)).toBe(true)
    expect(await ownerAlive(process.pid, null)).toBe(true)
    expect(await ownerAlive(process.pid, 'Mon Jan  1 00:00:00 1990')).toBe(false)
    expect(await ownerAlive(2_147_483_000, own.start)).toBe(false)
    expect(await ownerAlive(1, null)).toBe(true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(await ownerAlive(process.pid, 'Mon Jan  1 00:00:00 1990')).toBe(true)
  })
})
