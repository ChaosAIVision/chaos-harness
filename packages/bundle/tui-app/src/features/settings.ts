/** Terminal model selection, provider configuration and account controls. */
import { z } from 'zod'
import type { TerminalFeatureHost } from '../types.ts'
import { accepted, confirm, details, jsonValue, receipt, selected } from './common.ts'
import { featureText as t } from './locales.ts'

/** Select an adapter-owned model route and reasoning effort.
 * @param host - Current terminal services.
 */
export async function models(host: TerminalFeatureHost): Promise<void> {
  const session = selected(host)
  const catalog = accepted(await host.client.remote.session.modelCatalog())
  const model = await host.view.choose(t.model, catalog.groups.flatMap(group => group.models.map(model => ({
    label: `${group.name} / ${model.name}`,
    description: model.description ?? `${group.id}/${model.id}`,
    value: { provider: group.id, model },
  }))))
  if (model === undefined) {
    if (catalog.groups.length === 0) await host.view.show(t.model, details(catalog.failures))
    return
  }
  const efforts = model.model.reasoning?.efforts ?? []
  const reasoning = efforts.length === 0 ? { effort: undefined } : await host.view.choose<{ effort: string | undefined }>(t.reasoning, [
    { label: t.defaultReasoning, value: { effort: undefined } },
    ...efforts.map(effort => ({ label: effort.name, description: effort.description ?? effort.id, value: { effort: effort.id } })),
  ])
  if (reasoning === undefined) return
  await receipt(host, await host.client.remote.session.selectModel({
    sessionId: session.sessionId, provider: model.provider, model: model.model.id,
    ...reasoning.effort === undefined ? {} : { reasoningEffort: reasoning.effort },
  }))
}

/** Edit schema-owned settings using revision-checked field mutations.
 * @param host - Current terminal services.
 * @param namespace - Optional namespace selected by a provider presenter.
 */
export async function settings(host: TerminalFeatureHost, namespace?: string): Promise<void> {
  const description = accepted(await host.client.remote.settings.describe())
  const section = namespace === undefined
    ? await host.view.choose(t.settings, description.namespaces.map(item => ({ label: item.ns, value: item })))
    : description.namespaces.find(item => item.ns === namespace)
  if (section === undefined) return
  const action = await host.view.choose(section.ns, [
    { label: t.settingsInspect, value: 'inspect' },
    ...description.writable ? [{ label: t.settingsSet, value: 'set' }, { label: t.settingsUnset, value: 'unset' }] : [],
  ])
  if (action === undefined) return
  if (action === 'inspect') { await host.view.show(section.ns, details(section)); return }
  const pathText = await host.view.input(t.field, { initial: '[]' })
  if (pathText === undefined) return
  const path = z.array(z.string()).parse(JSON.parse(pathText))
  const secret = section.secrets.some(item => details(item.path) === details(path))
  if (action === 'unset') {
    await receipt(host, await host.client.remote.settings.mutate(section.ns, [{ op: 'unset', path }], section.revision))
    return
  }
  const raw = await host.view.input(secret ? t.secret : t.value, secret ? { secret: true } : {})
  if (raw === undefined) return
  const value = secret ? raw : jsonValue.parse(JSON.parse(raw))
  const result = await host.client.remote.settings.mutate(section.ns, [{ op: 'set', path, value }], section.revision)
  await host.view.show(t.done, details(accepted(result)))
}

/** Browse provider metadata, edit its owning settings, or manage credential references.
 * @param host - Current terminal services.
 */
export async function providers(host: TerminalFeatureHost): Promise<void> {
  const providers = accepted(await host.client.remote.llm.listConfigurableProviders())
  const action = await host.view.choose<{ kind: 'provider'; provider: typeof providers[number] } | { kind: 'credential' }>(t.providers, [
    ...providers.map(provider => ({ label: provider.displayName, description: provider.provider, value: { kind: 'provider' as const, provider } })),
    { label: t.setCredential, value: { kind: 'credential' as const } },
  ])
  if (action === undefined) return
  if (action.kind === 'provider' && 'provider' in action) {
    const provider = action.provider
    const operation = await host.view.choose(provider.displayName, [
      { label: t.details, value: 'details' }, { label: t.edit, value: 'edit' }, { label: t.discover, value: 'discover' },
    ])
    if (operation === 'details') await host.view.show(t.providerInspect, details(provider))
    if (operation === 'edit') await settings(host, provider.settingsNs)
    if (operation === 'discover') {
      const baseURL = await host.view.input(t.baseURL, { initial: provider.defaultBaseURL ?? '' })
      if (baseURL === undefined) return
      const api = await host.view.input(t.protocol)
      if (api === undefined) return
      const apiKey = await host.view.input(t.optionalApiKey, { secret: true })
      if (apiKey === undefined) return
      await receipt(host, await host.client.remote.llm.discoverModels(provider.settingsNs, {
        provider: provider.provider,
        ...baseURL.trim() === '' ? {} : { baseURL },
        ...api.trim() === '' ? {} : { api },
        ...apiKey === '' ? {} : { apiKey },
      }, host.signal))
    }
    return
  }
  const reference = await host.view.input(t.credential)
  if (reference === undefined) return
  const state = accepted(await host.client.remote.credentials.describe([reference]))
  const mode = await host.view.choose(t.credential, [
    { label: t.details, value: 'details' }, { label: t.setCredential, value: 'set' }, { label: t.unsetCredential, value: 'unset' },
  ])
  if (mode === 'details') await host.view.show(reference, details(state))
  if (mode === 'unset' && await confirm(host, t.unsetCredential)) await receipt(host, await host.client.remote.credentials.unset(reference))
  if (mode === 'set') {
    const secret = await host.view.input(t.secret, { secret: true })
    if (secret !== undefined) {
      accepted(await host.client.remote.credentials.set(reference, secret))
      await host.view.show(t.done, details(accepted(await host.client.remote.credentials.describe([reference]))))
    }
  }
}

/** Display account state and run the existing sign-in, cancel and sign-out operations.
 * @param host - Current terminal services.
 */
export async function account(host: TerminalFeatureHost): Promise<void> {
  const state = accepted(await host.client.remote.account.getState())
  const metadata = { version: '0.2.1-rc.3', locale: 'en', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }
  const action = await host.view.choose(t.account, [
    { label: t.details, value: 'state' }, { label: t.balance, value: 'balance' },
    { label: t.signIn, value: 'in' }, { label: t.signOut, value: 'out' },
    ...state.attempt === null ? [] : [{ label: t.cancelSignIn, value: 'cancel' }],
  ])
  if (action === 'state') await host.view.show(t.account, details(state))
  if (action === 'balance') {
    const profile = accepted(await host.client.remote.account.getProfile(metadata))
    const balance = accepted(await host.client.remote.account.getBalance(metadata))
    await host.view.show(t.account, details({ profile, balance }))
  }
  if (action === 'cancel' && state.attempt !== null) await receipt(host, await host.client.remote.account.cancelSignIn(state.attempt.id))
  if (action === 'out' && await confirm(host, t.signOut)) await receipt(host, await host.client.remote.account.signOut(metadata))
  if (action === 'in') {
    const response = await host.request('', { method: 'HEAD', signal: host.signal })
    const origin = new URL(response.url).origin
    const next = accepted(await host.client.remote.account.startSignIn(metadata, origin, 'web'))
    await host.view.show(t.signIn, `${t.signInBrowser}\n\n${next.attempt?.authorizeUrl ?? details(next)}`)
  }
}
