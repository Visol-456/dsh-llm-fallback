/**
 * Fallback settings page store: adapts this plugin entry's harness
 * configuration form (`ctx.configForms`) to the snapshot state the section
 * renders from, and writes an edited section back as one revision-fenced
 * mutation. Reads ride the settings domain's shared describe mirror (which
 * also owns pushed invalidation and reconnect refresh), so this file holds no
 * wire contract of its own.
 * @module @deepseek-ai/dsh-llm-fallback/client/store
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** One provider/model route (a fallback target). A type alias rather than an
 * interface: the settings wire path op carries `JsonValue`, and only alias
 * object types get the implicit index signature that assignment needs. */
export type FallbackProviderEntry = {
  /** Registered provider route. */
  provider: string
  /** Exact model id served by the route. */
  model: string
}

/** The section the page edits and writes. */
export interface FallbackConfig {
  /** Ordered backup targets; at least one when configured. */
  fallbacks: FallbackProviderEntry[]
  /** Failure codes eligible to switch; never empty. */
  switchCodes: string[]
  /** Consecutive eligible failures that open the circuit (>= 1). */
  failureThreshold: number
  /** Milliseconds the head stays excluded (>= 0). */
  cooldownMs: number
}

/** Why a write did not land, driving the page's failure copy. */
export type SaveErrorKind = 'conflict' | 'rejected' | 'transport'

/** Page snapshot. */
export interface FallbackSettingsState {
  /** Load phase; `error` status means the last explicit load failed. */
  status: 'loading' | 'ready' | 'error'
  /** Whether the Host serves this plugin entry's configuration form. */
  available: boolean
  /** Whether the Host accepts form writes. */
  writable: boolean
  /** `host` writes the profile entry; `memory` keeps a remote page process-local. */
  mode: 'host' | 'memory'
  /** Resolved config (defaults -> profile entry -> saved override). */
  value: FallbackConfig | undefined
  /** Monotonic revision of the entry's config; fences the next write. */
  revision: number | undefined
  /** Last write failure (null while clean). */
  error: { kind: SaveErrorKind; message: string } | null
  /** Whether a save or reset is crossing the wire. */
  saving: boolean
}

/** The schema-side cooldown ceiling (MAX_TIMER_DELAY_MS); mirrored here. */
export const MAX_COOLDOWN_MS = 2_147_483_647

/** Decode the form `value` into the structural config, refusing malformed shapes. */
export function decodeConfig(value: unknown): FallbackConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const root = value as Record<string, unknown>
  // Absent fallbacks = dormant (empty list); a non-array value is malformed.
  if (root.fallbacks !== undefined && !Array.isArray(root.fallbacks)) return undefined
  const fallbacks: FallbackProviderEntry[] = []
  if (Array.isArray(root.fallbacks)) {
  for (const entry of root.fallbacks) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const row = entry as Record<string, unknown>
    if (typeof row.provider !== 'string' || typeof row.model !== 'string') return undefined
    fallbacks.push({ provider: row.provider, model: row.model })
    }
  }
  const switchCodes = Array.isArray(root.switchCodes)
    ? root.switchCodes.filter((code): code is string => typeof code === 'string')
    : []
  const failureThreshold = typeof root.failureThreshold === 'number' ? root.failureThreshold : 1
  const cooldownMs = typeof root.cooldownMs === 'number' ? root.cooldownMs : 0
  return { fallbacks, switchCodes, failureThreshold, cooldownMs }
}

/** Human text for a transport failure. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Every field the page owns, in write order. */
const FIELDS = ['fallbacks', 'switchCodes', 'failureThreshold', 'cooldownMs'] as const

/**
 * The page controller. One instance per settings surface; reads derive from
 * the entry's shared form, writes queue through its single mutation lane, so
 * every edit carries one revision fence and one Host validation.
 */
export class FallbackSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<FallbackSettingsState> = createSnapshotStore<FallbackSettingsState>({
    status: 'loading',
    available: false,
    writable: false,
    mode: 'host',
    value: undefined,
    revision: undefined,
    error: null,
    saving: false,
  })

  private readonly form: ConfigForm<unknown>
  private readonly refresh: (() => Promise<void>) | undefined
  private readonly unsubscribe: () => void

  /**
   * @param form - this plugin entry's configuration form.
   * @param options - optional refresh hook (the settings describe face's
   * `ensure`) backing the page's explicit reload action.
   */
  constructor(form: ConfigForm<unknown>, options: { refresh?: () => Promise<void> } = {}) {
    this.form = form
    this.refresh = options.refresh
    this.unsubscribe = form.subscribe(() => { this.derive() })
    this.derive()
  }

  /** Release the form subscription (the harness owns the form itself). */
  dispose(): void {
    this.unsubscribe()
  }

  /** Re-derive from the current form snapshot and ask the mirror for a read. */
  async load(): Promise<void> {
    this.store.update((state) => {
      if (state.status !== 'ready') state.status = 'loading'
      state.error = null
    })
    this.derive()
    await this.refresh?.()
  }

  /**
   * Write the complete section (revision-fenced mutation).
   * @param section - the full resolved config the user edited.
   * @returns whether the write landed as staged.
   */
  async save(section: FallbackConfig): Promise<boolean> {
    return this.mutate([
      { op: 'set', path: ['fallbacks'], value: section.fallbacks },
      { op: 'set', path: ['switchCodes'], value: section.switchCodes },
      { op: 'set', path: ['failureThreshold'], value: section.failureThreshold },
      { op: 'set', path: ['cooldownMs'], value: section.cooldownMs },
    ])
  }

  /** Clear every saved field, so the entry returns to its inherited values. */
  async reset(): Promise<boolean> {
    return this.mutate(FIELDS.map(field => ({ op: 'unset', path: [field] })))
  }

  /** Fold the entry's form snapshot into the page state. */
  private derive(): void {
    const snapshot = this.form.getSnapshot()
    this.store.update((state) => {
      state.mode = snapshot.mode
      state.writable = snapshot.writable
      state.revision = snapshot.revision
      if (snapshot.status === 'loading') {
        state.status = 'loading'
        return
      }
      state.status = 'ready'
      state.available = snapshot.status === 'ready'
      state.value = state.available ? decodeConfig(snapshot.value) : undefined
    })
  }

  /**
   * Queue one atomic section edit and fold its outcome into the page state.
   * A refused write already reloaded the Host state inside the form; the page
   * reports a conflict exactly when that reload moved the revision.
   */
  private async mutate(ops: readonly SettingsPathOpView[]): Promise<boolean> {
    if (this.store.getSnapshot().saving) return false
    const fenced = this.form.getSnapshot().revision
    this.store.update((state) => {
      state.saving = true
      state.error = null
    })
    try {
      const accepted = await this.form.mutate(ops)
      const revision = this.form.getSnapshot().revision
      this.store.update((state) => {
        state.saving = false
        if (accepted) {
          state.error = null
          return
        }
        state.error = revision !== undefined && revision !== fenced
          ? { kind: 'conflict', message: 'configuration changed elsewhere; reload and retry' }
          : { kind: 'rejected', message: 'the harness refused the configuration' }
      })
      return accepted
    } catch (error) {
      this.store.update((state) => {
        state.saving = false
        state.error = { kind: 'transport', message: messageOf(error) }
      })
      return false
    }
  }
}
