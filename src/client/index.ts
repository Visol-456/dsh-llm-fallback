/**
 * Fallback settings page, browser half. Registers the Fallback section in the
 * harness Settings panel (the same `settings.section` slot Models uses) and
 * binds it to this plugin entry's configuration form (`ctx.configForms`), so
 * edits land in the active profile patch through the harness settings
 * transport and rebuild the routing circuit hot. The section registers only
 * while the Host serves the namespace, so a deployment without the Host half
 * shows no trace of the page.
 * @module @deepseek-ai/dsh-llm-fallback/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.slots Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings.section slot declaration and ctx.configForms
// into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge (the provider/model catalog face) into
// this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { FallbackSettingsStore } from './store.ts'
import { FallbackSection, type FallbackSectionInjected } from './FallbackSection.tsx'
import { en, zh, type FallbackKey } from './locales.ts'

export type { FallbackSectionInjected, FallbackSectionProps } from './FallbackSection.tsx'
export type {
  FallbackConfig, FallbackProviderEntry,
  FallbackSettingsState, SaveErrorKind,
} from './store.ts'
export { FallbackSettingsStore, MAX_COOLDOWN_MS, decodeConfig } from './store.ts'
export type { FallbackKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Fallback settings page copy. */
    'llm-fallback': FallbackKey
  }
}

/**
 * Dictionary namespace owned by this plugin; also the Host profile entry id
 * carrying the fallback Config, which is the key its settings form is filed
 * under (see `src/index.ts` and `cordis.patch.yml`).
 */
const NS = 'llm-fallback'

/**
 * Required services (cordis fiber inject): slots and locale for the section
 * registration, configForms for this entry's configuration form, and remote
 * for the model catalog the provider/model pickers read.
 */
export const inject = ['slots', 'locale', 'configForms', 'remote']

/**
 * Register the Fallback section while the Host serves this entry's config
 * form, and bind the page to that form.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallback: dictionaries')

  const t = ctx.locale.bind(NS) as FallbackSectionInjected['t']

  ctx.effect(() => ctx.configForms.whileServed([NS], () => {
    const controller = new FallbackSettingsStore(ctx.configForms.get(NS), {
      refresh: () => ctx.configForms.describe().ensure(),
    })
    const injected = (): FallbackSectionInjected => ({
      controller,
      hooks: { snapshot: controller.store },
      api: ctx.remote,
      t,
    })

    void controller.load()

    const stopWaiting = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: NS,
      order: 20,
      label: () => t('nav'),
      inject: injected,
    }, FallbackSection))

    return () => {
      stopWaiting()
      controller.dispose()
    }
  }), 'llm-fallback: settings section')
}
