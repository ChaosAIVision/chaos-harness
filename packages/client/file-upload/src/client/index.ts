/** Browser background-upload Cordis service. */

import type { Context } from '@deepseek-ai/cordis'
import { FileUploadRuntime } from './runtime.ts'
import type { FileUploadService } from './contract.ts'
import type { ClientFileUploadHooks } from '../types.ts'

export type { FileUploadProgress, FileUploadService } from './contract.ts'
export type { FileUploadReceiptId, FileUploadValue } from '../types.ts'
export type { ClientFileUploadHooks } from '../types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Session-addressed browser service for staged file uploads. */
    fileUpload: FileUploadService
  }
}

/** The upload service uses the generated Remote fallback. */
export const inject = ['remote']

/**
 * Provide the browser background-upload service.
 * @param ctx - Client plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(FileUploadRuntime)
}

/**
 * Install one Client's upload service with an explicit authenticated carrier.
 * @param ctx - Client context that owns the upload service.
 * @param hooks - carrier private to this Client, overriding any page boot hook.
 * @returns the mounted service's disposable Cordis fiber.
 */
export function installFileUpload(ctx: Context, hooks: ClientFileUploadHooks) {
  return ctx.plugin(FileUploadRuntime, hooks)
}
