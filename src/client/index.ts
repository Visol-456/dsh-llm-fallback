/**
 * Fallback configuration page, browser half. Registers this bundle's
 * configuration body into the Plugins page's `plugins.bundle.config` slot
 * (keyed by the bundle's package name), where the page draws the card, the
 * bundle title, the package description, and the crumb, and mounts this entry
 * on the bundle's detail page. The form binds to this plugin entry's
 * configuration form (`ctx.configForms`), so edits land in the active profile
 * patch through the harness settings transport and rebuild the routing circuit
 * hot. The registration exists only while the Host serves the namespace, so a
 * deployment without the Host half shows no Configure control.
 * @module @deepseek-ai/dsh-llm-fallback/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.slots Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.configForms Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the plugins.bundle.config SlotMap entry into this program.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge (the provider/model catalog face) into
// this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { FallbackSettingsStore } from './store.ts'
import { FallbackBundleConfig, type FallbackBundleConfigInjected } from './FallbackBundleConfig.tsx'
import { en, zh, type FallbackKey } from './locales.ts'

export type { FallbackBundleConfigInjected, FallbackBundleConfigProps } from './FallbackBundleConfig.tsx'
export type {
  FallbackConfig, FallbackProviderEntry,
  FallbackSettingsState, SaveErrorKind,
} from './store.ts'
export { FallbackSettingsStore, MAX_COOLDOWN_MS, decodeConfig } from './store.ts'
export type { FallbackKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Fallback configuration page copy. */
    'llm-fallback': FallbackKey
  }
}

/**
 * Settings namespace owned by this plugin; also the Host profile entry id
 * carrying the fallback Config, which is the key its settings form is filed
 * under (see `src/index.ts` and `cordis.patch.yml`).
 */
const NS = 'llm-fallback'

/**
 * The Plugins page keys `plugins.bundle.config` by the bundle's npm package
 * name (the profile's dependency name), which is what its detail page passes
 * as the slot's `entryKey`. This is deliberately not the cordis entry id: the
 * page knows bundles by package, the settings form by namespace.
 */
const BUNDLE_ID = '@visol-456/dsh-llm-fallback'

/**
 * Required services (cordis fiber inject): slots and locale for the entry
 * registration, configForms for this entry's configuration form, and remote
 * for the model catalog the provider/model pickers read.
 *
 * Every mounted Remote namespace is its own cordis service, so reading
 * `ctx.remote.session.modelCatalog` (the provider/model pickers) needs
 * `'remote.session'` declared *in addition to* `'remote'`. Declaring only
 * `'remote'` makes the undeclared namespace access throw
 * `cannot get property "remote.session" without inject` inside the slot
 * outlet, which surfaces as an empty configuration panel.
 * tests/client-inject.spec.ts pins this list against every namespace the
 * client half actually reads.
 */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

/**
 * Register this bundle's configuration body while the Host serves this entry's
 * config form, and bind the form to that entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallback: dictionaries')

  ctx.effect(() => ctx.configForms.whileServed([NS], () => {
    const controller = new FallbackSettingsStore(ctx.configForms.get(NS), {
      refresh: () => ctx.configForms.describe().ensure(),
    })
    const injected = (): FallbackBundleConfigInjected => ({
      controller,
      hooks: { snapshot: controller.store },
      api: ctx.remote,
    })

    void controller.load()

    const stopWaiting = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_ID,
      locale: NS,
      inject: injected,
    }, FallbackBundleConfig))

    return () => {
      stopWaiting()
      controller.dispose()
    }
  }), 'llm-fallback: bundle configuration')
}
