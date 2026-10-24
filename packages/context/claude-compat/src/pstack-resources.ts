/** Published pstack resources shared by source and built entrypoints. */
import { fileURLToPath } from 'node:url'

/** Resolve the pinned resource tree without consulting the working directory or shared agent home.
 * @returns absolute bundled pstack root in the current package installation.
 */
export function bundledPstackRoot(): string {
  return fileURLToPath(new URL('../resources/pstack/', import.meta.url))
}
