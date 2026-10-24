/** Background-job observation and revision-checked reminder management. */
import type { TerminalFeatureHost } from '../types.ts'
import { z } from 'zod'
import { accepted, confirm, details, positiveInteger, receipt, selected } from './common.ts'
import { featureText as t } from './locales.ts'

/** Read the selected session's actual job roster, output and stop operation.
 * @param host - Current terminal services.
 */
export async function jobs(host: TerminalFeatureHost): Promise<void> {
  const sessionId = selected(host).sessionId
  const stream = host.client.remote.job.list({ sessionId }, host.signal)
  try {
    for await (const frame of stream) {
      const job = await host.view.choose(t.jobs, frame.jobs.map(job => ({
        label: `${job.label} [${job.status}]`, description: job.progress ?? job.id, value: job,
      })))
      if (job === undefined) return
      const action = await host.view.choose(job.label, [
        { label: t.details, value: 'details' }, { label: t.output, value: 'output' }, { label: t.stop, value: 'stop' },
      ])
      if (action === 'details') await host.view.show(job.label, details(job))
      if (action === 'stop') await receipt(host, await host.client.remote.job.kill({ sessionId, jobId: job.id }))
      if (action === 'output') {
        await host.view.terminal(job.label, async (lease) => {
          const output = host.client.remote.job.follow({ jobId: job.id, ...job.owner === undefined ? {} : { sessionId: job.owner } }, lease.signal)
          try {
            for await (const item of output) {
              if (item.type === 'opened' && item.from > 0) lease.write(`[${item.from} bytes unavailable]\r\n`)
              if (item.type === 'output') for (const chunk of item.chunks) lease.write(chunk.text)
              if (item.type === 'status') lease.write(`\r\n[${item.job.status}]\r\n`)
            }
          } finally { output.dispose() }
        })
      }
      return
    }
  } finally { stream.dispose() }
}

/** Browse tasks, edit instructions or timing, inspect deliveries and delete tasks.
 * @param host - Current terminal services.
 */
export async function schedules(host: TerminalFeatureHost): Promise<void> {
  const records = accepted(await host.client.remote.schedule.catalog())
  const row = await host.view.choose<{ kind: 'create' } | { kind: 'record'; record: typeof records[number] }>(t.schedules, [
    { label: t.create, value: { kind: 'create' as const } },
    ...records.map(record => ({ label: `${record.title} [${record.status}]`, description: record.scheduledAt, value: { kind: 'record' as const, record } })),
  ])
  if (row === undefined) return
  if (!('record' in row)) { await host.view.show(t.schedules, t.scheduleCreateUnavailable); return }
  const record = row.record
  const action = await host.view.choose(record.title, [
    { label: t.details, value: 'details' }, { label: t.changeTitle, value: 'title' },
    { label: t.changePrompt, value: 'prompt' }, { label: t.changeTime, value: 'time' },
    { label: t.history, value: 'history' }, { label: t.open, value: 'open' }, { label: t.remove, value: 'delete' },
  ])
  if (action === 'details') await host.view.show(record.title, details(record))
  if (action === 'open') await host.select(record.sessionId)
  if (action === 'history') await receipt(host, await host.client.remote.schedule.history({ sessionId: record.sessionId, id: record.id, limit: 100 }))
  if (action === 'delete' && await confirm(host, `${t.remove}: ${record.title}`)) {
    await receipt(host, await host.client.remote.schedule.delete({ sessionId: record.sessionId, id: record.id }))
  }
  if (action === 'title' || action === 'prompt') {
    const value = await host.view.input(action === 'title' ? t.scheduleTitle : t.schedulePrompt, { initial: record[action] })
    if (value === undefined) return
    await receipt(host, await host.client.remote.schedule.update({
      sessionId: record.sessionId, id: record.id, expected: record,
      ...action === 'title' ? { title: value } : { prompt: value },
    }))
  }
  if (action === 'time') {
    const kind = await host.view.choose(t.timing, [
      { label: t.at, value: 'at' }, { label: t.every, value: 'every' },
      { label: t.daily, value: 'daily' }, { label: t.weekly, value: 'weekly' }, { label: t.cron, value: 'cron' },
    ])
    if (kind === undefined) return
    const value = await host.view.input(kind === 'at' ? t.at : kind === 'every' ? t.every : kind === 'cron' ? t.cron : t.clockTime)
    if (value === undefined) return
    type Timing = NonNullable<Parameters<typeof host.client.remote.schedule.update>[0]['change']>
    let change: Timing
    if (kind === 'at') change = { kind: 'at', at: value }
    else if (kind === 'every') change = { kind: 'every', every_seconds: positiveInteger(value) }
    else {
      const time_zone = await host.view.input(t.timeZone, { initial: Intl.DateTimeFormat().resolvedOptions().timeZone })
      if (time_zone === undefined) return
      if (kind === 'cron') change = { kind: 'cron', cron: { expression: value, time_zone } }
      else if (kind === 'daily') change = { kind: 'daily', daily: { time: value, time_zone } }
      else {
        const raw = await host.view.input(t.weekdays, { initial: '[1,2,3,4,5]' })
        if (raw === undefined) return
        const weekdays = z.array(z.number().int().min(1).max(7)).min(1).parse(JSON.parse(raw))
        change = { kind: 'weekly', weekly: { time: value, time_zone, weekdays } }
      }
    }
    await receipt(host, await host.client.remote.schedule.update({
      sessionId: record.sessionId, id: record.id, expected: record, change,
    }))
  }
}
