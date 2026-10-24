/** Isolated source-mode process for preference publication and transaction tests. */
import { spawn } from 'node:child_process'

/** Start a child that announces readiness, then waits for an explicit continuation.
 * @param script - ESM statements with access to the imported config module and waitForParent.
 * @returns readiness, completion output, and an explicit continuation callback.
 */
export function configProcess(script: string) {
  const module = new URL('../src/pstack-config.ts', import.meta.url).href
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', `
    import * as config from ${JSON.stringify(module)};
    const waitForParent = () => new Promise(resolve => {
      process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
      process.stdout.write('READY\\n');
    });
    ${script}
  `], { env: process.env })
  let output = ''
  let errors = ''
  let ready: () => void = () => {}
  const started = new Promise<void>((resolve) => { ready = resolve })
  child.stdout.on('data', (chunk) => { output += String(chunk); if (output.includes('READY\n')) ready() })
  child.stderr.on('data', (chunk) => { errors += String(chunk) })
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(output.replaceAll('READY\n', ''))
      else reject(new Error(errors))
    })
  })
  return { started: Promise.race([started, done.then(() => {})]), done, resume: () => child.stdin.end('continue\n') }
}
