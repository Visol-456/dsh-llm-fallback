/**
 * Test support: reimplementation of the `bindSnapshotSelector` hook from
 * `@deepseek-ai/dsh-client-web-react` (uSES bridge), which ships only as a
 * browser module-loader bundle. Uses the same shim the harness uses.
 * @module test/support/web-react
 */

import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector.js'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

export type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Bind a bare observable snapshot source to a typed selector hook.
 * @param source - the snapshot source (getSnapshot/subscribe).
 * @returns the selector hook.
 */
export function bindSnapshotSelector<T>(source: { getSnapshot(): T; subscribe(fn: () => void): () => void }): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => source.subscribe(fn)
  const getSnapshot = () => source.getSnapshot()
  return function useSelector<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean): S {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)
  }
}
