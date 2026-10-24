/** First-party plugin inventory and persistent profile management. */
import type { TerminalFeatureHost } from '../types.ts'
import type { PluginInstallRequestId, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { randomUUID } from 'node:crypto'
import { accepted, confirm, details, receipt } from './common.ts'
import { featureText as t } from './locales.ts'

async function installation<T>(host: TerminalFeatureHost, title: string, run: (requestId: PluginInstallRequestId) => Promise<RemoteResult<T>>): Promise<void> {
  const requestId = brandString<PluginInstallRequestId>(randomUUID())
  let outcome: T | undefined
  await host.view.terminal(title, async lease => {
    const unsubscribe = host.client.remote.$on('plugin-manager/install-log', chunk => {
      if (chunk.requestId === requestId) lease.write(chunk.text)
    })
    let cancellation: Promise<unknown> | undefined
    const cancel = (): void => { cancellation = host.client.remote.pluginManager.cancelInstall(requestId) }
    const unsubscribeState = host.client.remote.$on('plugin-manager/install-state', progress => {
      if (progress.requestId === requestId && progress.phase === 'installing' && lease.signal.aborted) cancel()
    })
    lease.signal.addEventListener('abort', cancel, { once: true })
    try { lease.signal.throwIfAborted(); outcome = accepted(await run(requestId)) }
    finally {
      lease.signal.removeEventListener('abort', cancel)
      unsubscribe()
      unsubscribeState()
      await cancellation
    }
  })
  if (outcome !== undefined) await host.view.show(t.done, details(outcome))
}

/** Inspect installed compositions and apply Host-owned bundle/plugin changes.
 * @param host - Current terminal services.
 */
export async function plugins(host: TerminalFeatureHost): Promise<void> {
  const inventory = accepted(await host.client.remote.pluginInventory.list())
  const action = await host.view.choose(t.plugins, [
    { label: t.inventory, value: 'inventory' },
    ...inventory.managementAvailable === true ? [
      { label: t.bundles, value: 'bundles' }, { label: t.entries, value: 'entries' }, { label: t.install, value: 'install' },
    ] : [],
  ])
  if (action === 'inventory') await host.view.show(t.inventory, details(inventory))
  if (action === 'entries') {
    const entries = accepted(await host.client.remote.pluginManager.listPlugins())
    const entry = await host.view.choose(t.entries, entries.map(entry => ({ label: `${entry.moduleName} [${entry.enabled ? t.enable : t.disable}]`, description: entry.readOnlyReason ?? entry.entryId, value: entry })))
    if (entry === undefined) return
    if (entry.readOnlyReason !== undefined) { await host.view.show(t.readOnly, details(entry)); return }
    if (await confirm(host, `${entry.enabled ? t.disable : t.enable}: ${entry.moduleName}`)) {
      await receipt(host, await host.client.remote.pluginManager.setPluginEnabled(entry.entryId, !entry.enabled))
    }
  }
  if (action === 'bundles') {
    const bundles = accepted(await host.client.remote.pluginManager.listBundles())
    const bundle = await host.view.choose(t.bundles, bundles.map(bundle => ({ label: bundle.name, description: bundle.description ?? bundle.version ?? '', value: bundle })))
    if (bundle === undefined) return
    const operation = await host.view.choose(bundle.name, [
      { label: t.details, value: 'details' }, { label: bundle.enabled ? t.disable : t.enable, value: 'toggle' },
      ...bundle.removable ? [{ label: t.remove, value: 'remove' }] : [],
      ...bundle.updatable ? [{ label: t.update, value: 'update' }] : [],
    ])
    if (operation === 'details') {
      const detail = accepted(await host.client.remote.pluginManager.readBundleDetail(bundle.name, 'en'))
      await host.view.show(bundle.name, detail.status === 'found' ? detail.markdown : details(bundle))
    }
    if (operation === 'toggle' && await confirm(host, `${bundle.enabled ? t.disable : t.enable}: ${bundle.name}`)) {
      await receipt(host, await host.client.remote.pluginManager.setBundleEnabled(bundle.name, !bundle.enabled))
    }
    if (operation === 'remove' && await confirm(host, `${t.remove}: ${bundle.name}`)) await receipt(host, await host.client.remote.pluginManager.removeBundle(bundle.name))
    if (operation === 'update') {
      const versions = accepted(await host.client.remote.pluginManager.listVersions(bundle.name, {}))
      if (versions.status !== 'listed') { await host.view.show(t.update, details(versions)); return }
      const version = await host.view.choose(t.version, versions.versions.map(version => ({ label: version.version, value: version.version })))
      if (version !== undefined && await confirm(host, `${t.update}: ${bundle.name}@${version}`)) {
        await installation(host, `${t.update}: ${bundle.name}`, requestId => host.client.remote.pluginManager.updateBundle(bundle.name, version, { registry: versions.registry, requestId }))
      }
    }
  }
  if (action === 'install') {
    const spec = await host.view.input(t.spec)
    if (spec === undefined) return
    const inspection = accepted(await host.client.remote.pluginManager.inspect(spec, {}, host.signal))
    await host.view.show(t.installReview, details(inspection))
    if (inspection.status === 'accepted' && await confirm(host, `${t.install}: ${spec}`)) {
      await installation(host, `${t.install}: ${spec}`, requestId => host.client.remote.pluginManager.installBundle(spec, { requestId }))
    }
  }
}
