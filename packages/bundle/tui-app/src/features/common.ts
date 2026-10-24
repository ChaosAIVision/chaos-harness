/** Small typed helpers shared by terminal presenters. */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { z } from 'zod'
import type { TerminalFeatureHost } from '../types.ts'
import { featureText as t } from './locales.ts'

/** Require an accepted Remote result without treating a refusal as success.
 * @param result - Generated Remote answer.
 * @returns Accepted value.
 */
export function accepted<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

/** Borrow the selected session for one foreground operation.
 * @param host - Terminal owner.
 * @returns Current retained face.
 */
export function selected(host: TerminalFeatureHost): SessionFace {
  const session = host.current()
  if (session === undefined) throw new Error(t.noSession)
  return session
}

/** Render a structured result with its field names intact.
 * @param value - Typed operation output.
 * @returns Readable JSON.
 */
export function details(value: unknown): string { return JSON.stringify(value, null, 2) ?? '' }

/** Ask for explicit confirmation before destructive profile operations.
 * @param host - Terminal owner.
 * @param title - Concrete action being confirmed.
 * @returns Whether the user accepted.
 */
export async function confirm(host: TerminalFeatureHost, title: string): Promise<boolean> {
  return await host.view.choose(title, [{ label: t.no, value: false }, { label: t.yes, value: true }]) === true
}

/** Show the authoritative receipt after an operation.
 * @param host - Terminal owner.
 * @param result - Typed Remote result.
 */
export async function receipt<T>(host: TerminalFeatureHost, result: RemoteResult<T>): Promise<void> {
  await host.view.show(t.done, details(accepted(result)))
}

/** Parse user-authored JSON before it reaches typed settings operations. */
export const jsonValue = z.json()

/** Parse a positive integer from user input.
 * @param text - Editor content.
 * @returns A positive safe integer.
 */
export function positiveInteger(text: string): number { return z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(text) }
