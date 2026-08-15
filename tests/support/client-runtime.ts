/**
 * Test support: a faithful minimal reimplementation of the harness snapshot
 * store engine (`@deepseek-ai/dsh-client-runtime/client`), which ships only
 * as a browser module-loader bundle that cannot execute under Node. Only the
 * surface `FallbackSettingsStore` uses is implemented: getSnapshot /
 * subscribe / update / set, with update mutating a draft copy.
 * @module test/support/client-runtime
 */

/** Minimal observable snapshot source (mirror of the harness contract). */
export interface ObservableSnapshot<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
}

/** Writable snapshot store (mirror of the harness contract). */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  update(mutator: (draft: T) => void): void
  set(next: T): void
}

/**
 * Create a snapshot store. `update` clones the current state (structured
 * clone: the harness states are plain JSON data), applies the mutator, and
 * notifies synchronously.
 * @param init - initial state.
 * @returns the store.
 */
export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    update: (mutator) => {
      const draft = structuredClone(state)
      mutator(draft)
      state = draft
      for (const fn of [...listeners]) fn()
    },
    set: (next) => {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}
