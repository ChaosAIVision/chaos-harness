/** Terminal invocation parsing does not start a second application for help. */
import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTerminalLaunch } from '../src/startup.ts'

afterEach(() => { internals.stdout = process.stdout; internals.stderr = process.stderr })
function parse(args: string[]) {
  const ctx = new Context()
  const exits: number[] = []
  let output = ''
  const capture = { write: (value: string) => { output += value; return true } }
  internals.stdout = capture
  internals.stderr = capture
  provideCmdline(ctx, { args, exit: (code) => { exits.push(code) } })
  return { launch: parseTerminalLaunch(ctx), exits, output }
}
describe('Terminal startup', () => {
  it('opens a new session on the owned Web Host by default', () => {
    expect(parse([]).launch).toEqual({ cwd: process.cwd(), initial: { kind: 'new' }, host: { kind: 'owned', profile: 'web' } })
  })
  it('selects explicit attachment and session navigation', () => {
    expect(parse(['--connect-url-file', '/tmp/connect', '--resume', 'session-id']).launch).toEqual({ cwd: process.cwd(), initial: { kind: 'session', sessionId: 'session-id' }, host: { kind: 'attached', connectUrlFile: '/tmp/connect' } })
    expect(parse(['--load']).launch?.initial).toEqual({ kind: 'picker' })
    expect(parse(['--preset', 'standard']).launch?.initial).toEqual({ kind: 'new', preset: 'standard' })
  })
  it('shows help without an accepted invocation and rejects conflicting navigation', () => {
    const help = parse(['--help'])
    expect(help.launch).toBeUndefined()
    expect(help.exits).toEqual([0])
    expect(help.output).toContain('--connect-url-file')
    expect(help.output).toContain('current working directory')
    expect(help.output).not.toContain(process.cwd())
    expect(parse(['--load', '--resume', 'id']).exits).toEqual([1])
  })
})
