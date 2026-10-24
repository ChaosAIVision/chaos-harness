/** Terminal presentations of first-party Host operations. */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TerminalFeatureCommand, TerminalFeatureHost } from './types.ts'
import { account, models, providers, settings } from './features/settings.ts'
import { jobs, schedules } from './features/tasks.ts'
import { queue, sessions, subagents, trajectory, workspaces } from './features/navigation.ts'
import { plugins } from './features/plugins.ts'
import { terminals } from './features/terminals.ts'
import { deliverables, diff, document, exportSession, files, upload } from './resources.ts'
import { featureText as t } from './features/locales.ts'

const features = [
  { name: 'model', description: t.model, run: models },
  { name: 'providers', description: t.providers, run: providers },
  { name: 'settings', description: t.settings, run: settings },
  { name: 'account', description: t.account, run: account },
  { name: 'jobs', description: t.jobs, run: jobs },
  { name: 'schedules', description: t.schedules, run: schedules },
  { name: 'workspaces', description: t.workspaces, run: workspaces },
  { name: 'sessions', description: t.sessions, run: sessions },
  { name: 'subagents', description: t.subagents, run: subagents },
  { name: 'queue', description: t.queue, run: queue },
  { name: 'files', description: t.files, run: files },
  { name: 'document', description: t.documents, run: async (host: TerminalFeatureHost) => {
    const path = await host.view.input(t.path)
    if (path !== undefined) await document(host, path)
  } },
  { name: 'diff', description: t.diff, run: diff },
  { name: 'deliverables', description: t.deliverables, run: deliverables },
  { name: 'upload', description: t.upload, run: upload },
  { name: 'export', description: t.export, run: exportSession },
  { name: 'trajectory', description: t.trajectory, run: trajectory },
  { name: 'plugins', description: t.plugins, run: plugins },
  { name: 'terminals', description: t.terminals, run: terminals },
]

/** Terminal-specific commands merged with dynamic Host commands and skills. */
export const terminalFeatureCommands: readonly TerminalFeatureCommand[] = features.map(({ name, description }) => ({ name, description }))

/** Handle only known terminal commands, leaving other lines to Host command admission.
 * @param line - Complete input including leading slash.
 * @param host - Retained session and terminal presentation owner.
 * @returns Whether a terminal feature owned this input.
 */
export async function handleTerminalFeature(line: string, host: TerminalFeatureHost): Promise<boolean> {
  const match = /^\/([\w-]+)\s*$/.exec(line)
  const name = match?.[1]
  const feature = features.find(feature => feature.name === name)
  if (feature === undefined) return false
  try { await feature.run(host) }
  catch (error) {
    if (!host.signal.aborted) await host.view.show(t.error, error instanceof Error ? error.message : String(error))
  }
  return true
}
