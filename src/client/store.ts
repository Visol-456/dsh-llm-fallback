/**
 * Fallback settings page store: loads the resolved config from the plugin's
 * loopback-only config bridge, writes the full section back (revision-fenced),
 * and clears it back to cordis.yml. The bridge mirrors the node half's
 * `src/config-http.ts` wire contract; this file owns the client-side contract
 * copy so the browser bundle stays self-contained.
 * @module @deepseek-ai/dsh-llm-fallback/client/store
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Route the bridge is served on (same-origin with the web shell). */
export const CONFIG_PATH = '/llm-fallback/config'

/** One provider/model route (a fallback target). */
export interface FallbackProviderEntry {
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

/** Wire view of the config bridge (mirror of the node half's response). */
export interface FallbackConfigView {
  available: boolean
  writable: boolean
  hasDocument: boolean
  value: unknown
  base?: unknown
  user?: unknown
  revision: number
}

/** Why a write did not land, driving the page's failure copy. */
export type SaveErrorKind = 'conflict' | 'rejected' | 'transport'

/** Page snapshot. */
export interface FallbackSettingsState {
  /** Load phase; `error` status means the GET failed. */
  status: 'loading' | 'ready' | 'error'
  /** Whether a settings provider serves the namespace. */
  available: boolean
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Whether the provider owns a local user-editable document. */
  hasDocument: boolean
  /** Resolved config (defaults -> cordis.yml base -> saved section). */
  value: FallbackConfig | undefined
  /** Monotonic revision of the raw user section; fences the next write. */
  revision: number | undefined
  /** Last write failure (null while clean). */
  error: { kind: SaveErrorKind; message: string } | null
  /** Whether a save or reset is crossing the wire. */
  saving: boolean
}

/** The schema-side cooldown ceiling (MAX_TIMER_DELAY_MS); mirrored here. */
export const MAX_COOLDOWN_MS = 2_147_483_647

/** Decode the wire `value` into the structural config, refusing malformed shapes. */
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

/**
 * The page controller. One instance per settings surface; reads and writes
 * run through the same bridge the node half serves.
 */
export class FallbackSettingsStore {
  /** The snapshot the section renders from (uSES-safe store). */
  readonly store: SnapshotStore<FallbackSettingsState> = createSnapshotStore<FallbackSettingsState>({
    status: 'loading',
    available: false,
    writable: false,
    hasDocument: false,
    value: undefined,
    revision: undefined,
    error: null,
    saving: false,
  })

  /** Refetch the resolved config. */
  async load(): Promise<void> {
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    try {
      const response = await fetch(CONFIG_PATH, { headers: { accept: 'application/json' } })
      const view = await response.json() as FallbackConfigView
      if (!response.ok || !view.available) {
        this.store.update((state) => {
          state.status = 'ready'
          state.available = view.available === true
          state.writable = view.writable === true
          state.hasDocument = view.hasDocument === true
          state.value = undefined
          state.revision = undefined
        })
        return
      }
      this.store.update((state) => {
        state.status = 'ready'
        state.available = true
        state.writable = view.writable === true
        state.hasDocument = view.hasDocument === true
        state.value = decodeConfig(view.value)
        state.revision = view.revision
        state.error = null
      })
    } catch (error) {
      this.store.update((state) => {
        state.status = 'error'
        state.error = { kind: 'transport', message: messageOf(error) }
      })
    }
  }

  /**
   * Write the complete section (revision-fenced replace).
   * @param section - the full resolved config the user edited.
   * @returns whether the write landed as staged.
   */
  async save(section: FallbackConfig): Promise<boolean> {
    return this.write({ method: 'PUT', body: { section } })
  }

  /** Clear the saved user section, returning to cordis.yml values. */
  async reset(): Promise<boolean> {
    return this.write({ method: 'DELETE' })
  }

  private async write(options: { method: 'PUT' | 'DELETE'; body?: { section: FallbackConfig } }): Promise<boolean> {
    if (this.store.getSnapshot().saving) return false
    this.store.update((state) => {
      state.saving = true
      state.error = null
    })
    try {
      const body = options.body === undefined
        ? undefined
        : JSON.stringify({ expectedRevision: this.store.getSnapshot().revision, ...options.body })
      const response = await fetch(CONFIG_PATH, {
        method: options.method,
        headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
        ...body === undefined ? {} : { body },
      })
      const view = await response.json().catch(() => undefined) as FallbackConfigView | undefined
      if (response.status === 409) {
        this.store.update((state) => {
          state.saving = false
          state.error = { kind: 'conflict', message: view === undefined ? 'configuration changed elsewhere' : String((view as { error?: { message?: unknown } }).error?.message ?? 'configuration changed elsewhere') }
        })
        return false
      }
      if (!response.ok || view === undefined || !view.available) {
        this.store.update((state) => {
          state.saving = false
          state.error = {
            kind: 'rejected',
            message: view === undefined
              ? `bridge rejected the write (HTTP ${String(response.status)})`
              : String((view as { error?: { message?: unknown } }).error?.message ?? `bridge rejected the write (HTTP ${String(response.status)})`),
          }
        })
        return false
      }
      this.store.update((state) => {
        state.saving = false
        state.status = 'ready'
        state.available = true
        state.writable = view.writable === true
        state.hasDocument = view.hasDocument === true
        state.value = decodeConfig(view.value)
        state.revision = view.revision
        state.error = null
      })
      return true
    } catch (error) {
      this.store.update((state) => {
        state.saving = false
        state.error = { kind: 'transport', message: messageOf(error) }
      })
      return false
    }
  }
}
