/**
 * Per-chain provider fallback state machine: exact entry routing, consecutive
 * switchable-failure counting, cooldown re-derivation, and probe re-opening.
 * Pure and clock-injected so the plugin and its tests share one decision core.
 *
 * @module @deepseek-ai/dsh-llm-fallback/circuit
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** One chain entry: the exact registered provider route and model it serves. */
export interface FallbackEntry {
  readonly provider: string
  readonly model: string
}

/** Fully validated, detached configuration of one fallback chain. */
export interface ResolvedFallbackChain {
  /** Service priority order; the first entry is the head the chain is keyed on. */
  readonly entries: readonly FallbackEntry[]
  /** Failure codes that count toward a switch; other codes never switch. */
  readonly switchCodes: readonly string[]
  /** Consecutive switchable failures on the serving entry that open the circuit. */
  readonly failureThreshold: number
  /** Milliseconds a switched-away entry stays excluded before it may be probed again. */
  readonly cooldownMs: number
}

/** Why the circuit moved service away from the serving entry. */
export type FallbackSwitchReason = 'threshold' | 'probe'

/** One executed switch decision, reported for the durable event. */
export interface FallbackSwitch {
  /** The entry that was serving before the switch. */
  readonly from: FallbackEntry
  /** The entry that serves the retried request. */
  readonly to: FallbackEntry
  /** Why the switch happened. */
  readonly reason: FallbackSwitchReason
}

/** One request routed through a chain. */
export interface FallbackRoute {
  /** The entry that will serve the request. */
  readonly entry: FallbackEntry
  /** Whether the serving entry is not the chain head. */
  readonly fallback: boolean
}

interface EntryState {
  /** Earliest time the entry may serve again, or undefined while healthy. */
  downUntil: number | undefined
  /** Consecutive switchable failures while this entry served. */
  consecutiveFailures: number
}

/** Identifies the request chain that consumed the last switch. */
interface SwitchMarker {
  readonly agent: string
  readonly turn: number
  readonly step: number
}

/**
 * One fallback chain's circuit state. The state is process-local and shared
 * by every agent whose requests match the chain. The serving entry is an
 * explicit index advanced by switches; requests re-derive it back toward the
 * head when a higher-priority entry's cooldown has expired, except for the
 * exact request chain that consumed the last switch, whose retry stays on
 * the new entry (otherwise a zero cooldown would probe the head forever
 * inside one failed step).
 */
export class FallbackCircuit {
  private readonly states: EntryState[]
  private active = 0
  private marker: SwitchMarker | undefined

  /**
   * @param chain - validated chain configuration.
   * @param now - clock returning the current time in milliseconds.
   */
  constructor(
    private readonly chain: ResolvedFallbackChain,
    private readonly now: () => number,
  ) {
    this.states = chain.entries.map(() => ({ downUntil: undefined, consecutiveFailures: 0 }))
  }

  /** The chain head: the entry requests are keyed on. */
  head(): FallbackEntry {
    return this.entry(0)
  }

  /** The configured cooldown applied to entries switched away from. */
  cooldownMs(): number {
    return this.chain.cooldownMs
  }

  /** The chain entry at one index; config validation keeps the index in range. */
  private entry(index: number): FallbackEntry {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- validated chains keep every index in range
    return this.chain.entries[index]!
  }

  /** The live state of one entry; states mirror the validated entry list. */
  private state(index: number): EntryState {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- states mirrors the validated entry list
    return this.states[index]!
  }

  private eligible(index: number, time: number): boolean {
    const downUntil = this.state(index).downUntil
    return downUntil === undefined || time >= downUntil
  }

  private entryIndex(provider: string, model: string): number | undefined {
    const index = this.chain.entries.findIndex(entry =>
      entry.provider === provider && entry.model === model)
    return index === -1 ? undefined : index
  }

  /**
   * Route one proposed request config through the chain. Exact entry matches
   * are served by the currently active entry; the retried request of the
   * switch that moved service here stays on the new entry, while any other
   * request may re-derive service back to the highest-priority entry whose
   * cooldown has expired.
   * @param agent - agent id owning the request, part of the switch marker key.
   * @param turn - turn containing the request.
   * @param step - step containing the request.
   * @param proposed - the config the loop would use without this chain.
   * @returns the serving entry, or undefined when the request matches no entry.
   */
  route(agent: string, turn: number, step: number, proposed: FallbackEntry): FallbackRoute | undefined {
    if (this.entryIndex(proposed.provider, proposed.model) === undefined) return undefined
    if (this.marker === undefined
      || this.marker.agent !== agent
      || this.marker.turn !== turn
      || this.marker.step !== step) {
      const time = this.now()
      for (let index = 0; index < this.active; index++) {
        if (this.eligible(index, time)) {
          this.active = index
          break
        }
      }
    }
    return { entry: this.entry(this.active), fallback: this.active > 0 }
  }

  /**
   * Charge one failed request to this chain when the serving entry's provider
   * served it and the failure is switchable, switching to the next entry when
   * the consecutive count reaches the threshold or the entry was a cooldown
   * probe. The last entry never switches; its failures stay terminal.
   * @param agent - agent id owning the failed request, part of the switch marker key.
   * @param turn - turn containing the failed request.
   * @param step - step containing the failed request.
   * @param provider - provider that served the failed request.
   * @param failure - serializable failure facts from the request boundary.
   * @returns the executed switch, or undefined when nothing moved.
   */
  recordFailure(
    agent: string,
    turn: number,
    step: number,
    provider: string,
    failure: LlmFailure,
  ): FallbackSwitch | undefined {
    if (provider !== this.entry(this.active).provider) return undefined
    if (!this.chain.switchCodes.includes(failure.code)) return undefined
    const state = this.state(this.active)
    state.consecutiveFailures += 1
    const probe = state.downUntil !== undefined
    if (state.consecutiveFailures < this.chain.failureThreshold && !probe) return undefined
    if (this.active === this.chain.entries.length - 1) return undefined
    const from = this.entry(this.active)
    state.downUntil = this.now() + this.chain.cooldownMs
    state.consecutiveFailures = 0
    this.active += 1
    this.marker = { agent, turn, step }
    return { from, to: this.entry(this.active), reason: probe ? 'probe' : 'threshold' }
  }

  /**
   * Mark the serving entry healthy after it served a request successfully:
   * clear its consecutive-failure count and its cooldown marker, so a later
   * failure is no longer mistaken for a failed probe (which would bypass the
   * failure threshold) and the threshold accumulates from zero again.
   * @param provider - provider of the successful response.
   */
  recordSuccess(provider: string): void {
    if (provider === this.entry(this.active).provider) {
      const state = this.state(this.active)
      state.consecutiveFailures = 0
      state.downUntil = undefined
    }
  }
}
