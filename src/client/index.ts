/**
 * Fallback settings page, browser half. Registers the Fallback section in the
 * harness Settings panel (the same `settings.section` slot Models uses) and
 * keeps it fresh on pushed invalidation and connection resets. The page reads
 * and writes the plugin's loopback config bridge; persistence rides the
 * settings seam (`<DSH_HOME>/settings.yaml`) through the node half.
 * @module @deepseek-ai/dsh-llm-fallback/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings.section slot declaration into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the ctx.locale Context merge into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (settings/document-updated) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-settings/types'
import { FallbackSettingsStore } from './store.ts'
import type { FallbackSettingsState } from './store.ts'
import { FallbackSection, type FallbackSectionInjected } from './FallbackSection.tsx'
import { en, zh, type FallbackKey } from './locales.ts'

export type { FallbackSectionInjected, FallbackSectionProps } from './FallbackSection.tsx'
export type {
  FallbackConfig, FallbackConfigView, FallbackProviderEntry,
  FallbackSettingsState, SaveErrorKind,
} from './store.ts'
export { FallbackSettingsStore, MAX_COOLDOWN_MS } from './store.ts'
export type { FallbackKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Fallback settings page copy. */
    'llm-fallback': FallbackKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'llm-fallback'

/**
 * Required services (cordis fiber inject): slots and locale for the section
 * registration, connection for the provider suggestion list, and remote for
 * pushed settings invalidations.
 */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Register the Fallback section once the `settings.section` declaration is on
 * the ledger, wire its store to the bridge, and keep it fresh on pushed
 * invalidations (settings document changes only for this namespace).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-fallback: dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const controller = new FallbackSettingsStore()
  const t = ctx.locale.bind(NS) as FallbackSectionInjected['t']
  const injected = (): FallbackSectionInjected => ({
    controller,
    hooks: { snapshot: controller.store },
    api: connection.api,
    t,
  })

  ctx.effect(() => {
    const refresh = (): void => { void controller.load() }
    const disposers = [
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns === NS) refresh()
      }),
      ctx.on('connection/reset', refresh),
    ]
    void controller.load()
    return () => { for (const dispose of disposers) dispose() }
  }, 'llm-fallback: pushed invalidations')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'llm-fallback',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, FallbackSection))
}
