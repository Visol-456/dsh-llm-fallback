/**
 * Test support: a minimal uSES selector-hook binding for the section tests.
 * The production binding lives in `@deepseek-ai/dsh-client-ui-renderer/client`,
 * which ships as a browser module-loader bundle and cannot execute under Node.
 * @module test/support/web-react
 */

import { useRef, useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

export type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Bind a bare observable snapshot source to a typed selector hook.
 * @param source - the snapshot source (getSnapshot/subscribe).
 * @returns the selector hook.
 */
export function bindSnapshotSelector<T>(source: { getSnapshot(): T; subscribe(fn: () => void): () => void }): SnapshotSelectorHook<T> {
  const subscribe = (fn: () => void) => source.subscribe(fn)
  return function useSelector<S>(select: (state: T) => S, equal?: (left: S, right: S) => boolean): S {
    const last = useRef<{ state: T; selected: S } | undefined>(undefined)
    const getSelected = (): S => {
      const state = source.getSnapshot()
      const previous = last.current
      if (previous !== undefined && Object.is(previous.state, state)) return previous.selected
      const selected = select(state)
      if (previous !== undefined && equal !== undefined && equal(previous.selected, selected)) {
        last.current = { state, selected: previous.selected }
        return previous.selected
      }
      last.current = { state, selected }
      return selected
    }
    return useSyncExternalStore(subscribe, getSelected, getSelected)
  }
}
