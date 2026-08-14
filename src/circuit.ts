/**
 * Per-chain fallback state machine for the dynamic-head model: the chain head
 * is the request itself (whatever provider/model the user or the default
 * config selected), never rewritten by this plugin. A chain only supplies the
 * fallback targets service moves to after switchable failures, plus the
 * threshold/cooldown rules. Pure and clock-injected so the plugin and its
 * tests share one decision core.
 *
 * The circuit keeps: an active fallback pointer (index into `fallbacks`, -1
 * while the head serves), per-fallback failure counts, the head's failure
 * count and cooldown, and a switch marker that pins the exact (agent, turn,
 * step) retry chain to the fallback that consumed the last switch.
 *
 * @module @deepseek-ai/dsh-llm-fallback/circuit
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** One provider/model route (a fallback target, or the runtime request head). */
export interface FallbackEntry {
  readonly provider: string
  readonly model: string
}

/** Match condition selecting which requests a chain covers. */
export interface FallbackMatch {
  /** Provider route the request must use. */
  readonly provider: string
  /** Optional exact model; absent matches any model of the provider. */
  readonly model?: string
}

/** Fully validated, detached configuration of one fallback chain. */
export interface ResolvedFallbackChain {
  /** Match condition; undefined means the default chain (any request). */
  readonly match: FallbackMatch | undefined
  /** Ordered backup targets; the head is never part of this list. */
  readonly fallbacks: readonly FallbackEntry[]
  /** Failure codes that count toward a switch; other codes never switch. */
  readonly switchCodes: readonly string[]
  /** Consecutive switchable failures on the serving entry that open the circuit. */
  readonly failureThreshold: number
  /** Milliseconds the head stays excluded after a switch before it may be probed again. */
  readonly cooldownMs: number
}

/** Why the circuit moved service away from the head (or one fallback). */
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
  /** Whether the serving entry is a fallback (a retry pinned by the switch marker). */
  readonly fallback: boolean
}

interface EntryState {
  /** Earliest time the fallback may serve again, or undefined while healthy. */
  downUntil: number | undefined
  /** Consecutive switchable failures while this fallback served. */
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
 * by every agent whose requests match the chain. The head is the runtime
 * request value (stored on the latest routed request); fallbacks are only
 * reached through the retry of the exact request that consumed a switch.
 */
export class FallbackCircuit {
  private readonly fallbacks: readonly FallbackEntry[]
  private readonly states: EntryState[]
  private headEntry: FallbackEntry = { provider: '', model: '' }
  private headDownUntil: number | undefined
  private headFailures = 0
  /** Index into `fallbacks`, or -1 while the head serves. */
  private active = -1
  private marker: SwitchMarker | undefined

  /**
   * @param chain - validated chain configuration.
   * @param now - clock returning the current time in milliseconds.
   */
  constructor(
    private readonly chain: ResolvedFallbackChain,
    private readonly now: () => number,
  ) {
    this.fallbacks = chain.fallbacks
    this.states = chain.fallbacks.map(() => ({ downUntil: undefined, consecutiveFailures: 0 }))
  }

  /** The chain's head: the provider/model of the latest routed request. */
  head(): FallbackEntry {
    return this.headEntry
  }

  /** Whether one request config falls under this chain's match condition. */
  matches(provider: string, model: string): boolean {
    const match = this.chain.match
    if (match === undefined) return true
    if (match.model !== undefined) return provider === match.provider && model === match.model
    return provider === match.provider
  }

  /** The configured cooldown applied to the head when service moves away. */
  cooldownMs(): number {
    return this.chain.cooldownMs
  }

  private markerMatches(agent: string, turn: number, step: number): boolean {
    return this.marker !== undefined
      && this.marker.agent === agent
      && this.marker.turn === turn
      && this.marker.step === step
  }

  /**
   * Route one proposed request config through the chain. The head is the
   * request itself: a new request is served by `proposed` unchanged. Only the
   * exact retried request of the switch that moved service to a fallback is
   * served by that fallback (otherwise a zero cooldown would probe the head
   * forever inside one failed step).
   * @param agent - agent id owning the request, part of the switch marker key.
   * @param turn - turn containing the request.
   * @param step - step containing the request.
   * @param proposed - the config the loop would use without this chain.
   * @returns the serving entry and whether it is a fallback.
   */
  route(agent: string, turn: number, step: number, proposed: FallbackEntry): FallbackRoute {
    if (this.markerMatches(agent, turn, step) && this.active >= 0) {
      return { entry: this.fallbacks[this.active]!, fallback: true }
    }
    // A new request is the head: record it and clear the fallback pointer once
    // the head's cooldown expired (the next failure then starts from the first
    // fallback again instead of reusing a stale one).
    this.headEntry = { provider: proposed.provider, model: proposed.model }
    if (this.active >= 0 && this.headDownUntil !== undefined && this.now() >= this.headDownUntil) {
      this.active = -1
    }
    return { entry: proposed, fallback: false }
  }

  /**
   * Charge one failed request to this chain. A head failure opens the circuit
   * when the consecutive switchable count reaches the threshold (or when the
   * head is being probed after its cooldown), moving service to the first
   * fallback; while the head is still cooling down, the request is served by
   * the fallback currently in service. A fallback failure advances to the
   * next fallback on the same rules; the last fallback never switches.
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
    const time = this.now()
    if (this.markerMatches(agent, turn, step) && this.active >= 0) {
      return this.recordFallbackFailure(agent, turn, step, provider, failure, time)
    }
    return this.recordHeadFailure(agent, turn, step, provider, failure, time)
  }

  private recordHeadFailure(
    agent: string,
    turn: number,
    step: number,
    provider: string,
    failure: LlmFailure,
    time: number,
  ): FallbackSwitch | undefined {
    if (provider !== this.headEntry.provider) return undefined
    if (!this.chain.switchCodes.includes(failure.code)) return undefined
    const probe = this.headDownUntil !== undefined
    if (this.headDownUntil !== undefined && time < this.headDownUntil) {
      // The head is still cooling down: do not re-account the threshold;
      // retry directly on the fallback currently in service (or pass through
      // when there is none).
      if (this.fallbacks.length === 0 || this.active < 0) return undefined
      this.marker = { agent, turn, step }
      return { from: this.headEntry, to: this.fallbacks[this.active]!, reason: 'probe' }
    }
    this.headFailures += 1
    if (this.headFailures < this.chain.failureThreshold && !probe) return undefined
    if (this.fallbacks.length === 0) return undefined
    const from = this.headEntry
    this.headDownUntil = time + this.chain.cooldownMs
    this.headFailures = 0
    this.active = 0
    this.marker = { agent, turn, step }
    return { from, to: this.fallbacks[0]!, reason: probe ? 'probe' : 'threshold' }
  }

  private recordFallbackFailure(
    agent: string,
    turn: number,
    step: number,
    provider: string,
    failure: LlmFailure,
    time: number,
  ): FallbackSwitch | undefined {
    const index = this.active
    const entry = this.fallbacks[index]!
    if (provider !== entry.provider) return undefined
    if (!this.chain.switchCodes.includes(failure.code)) return undefined
    const state = this.states[index]!
    state.consecutiveFailures += 1
    const probe = state.downUntil !== undefined
    if (state.consecutiveFailures < this.chain.failureThreshold && !probe) return undefined
    if (index === this.fallbacks.length - 1) return undefined
    const from = entry
    state.downUntil = time + this.chain.cooldownMs
    state.consecutiveFailures = 0
    this.active = index + 1
    this.marker = { agent, turn, step }
    return { from, to: this.fallbacks[index + 1]!, reason: probe ? 'probe' : 'threshold' }
  }

  /**
   * Mark the head (or one fallback) healthy after it served a request
   * successfully: clear its failure count and cooldown marker so a later
   * failure is no longer mistaken for a failed probe.
   * @param provider - provider of the successful response.
   * @param model - model of the successful response, when known.
   */
  recordSuccess(provider: string, model?: string): void {
    if (provider === this.headEntry.provider
      && (model === undefined || model === this.headEntry.model)) {
      this.headDownUntil = undefined
      this.headFailures = 0
      this.active = -1
      return
    }
    const index = this.fallbacks.findIndex(entry =>
      entry.provider === provider && (model === undefined || entry.model === model))
    if (index === -1) return
    const state = this.states[index]!
    state.consecutiveFailures = 0
    state.downUntil = undefined
  }
}
