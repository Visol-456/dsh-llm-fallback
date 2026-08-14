/**
 * Durable session-event payloads for provider fallback routing.
 * @module @deepseek-ai/dsh-llm-fallback/types
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one provider fallback switch executed after a failed request attempt. */
    'llm/fallback': LlmFallbackEventData
    /** Durable, non-surface record of one request served by a fallback target. */
    'llm/fallback-route': LlmFallbackRouteEventData
  }
}

/** Durable payload recorded when the chain moves service from one entry to the next. */
export interface LlmFallbackEventData {
  /** Turn containing the failed request that triggered the switch. */
  turn: number
  /** Step containing the failed request attempt. */
  step: number
  /** Provider route of the chain head. */
  headProvider: string
  /** Model of the chain head. */
  headModel: string
  /** Provider route the chain moved away from. */
  fromProvider: string
  /** Model the chain moved away from. */
  fromModel: string
  /** Provider route that will serve the retried request. */
  toProvider: string
  /** Model that will serve the retried request. */
  toModel: string
  /** Why the switch happened: `threshold` counts consecutive switchable failures, `probe` re-opens after one failed cooldown probe. */
  reason: 'threshold' | 'probe'
  /** The failure that triggered the switch. */
  failure: LlmFailure
  /** Chain cooldown in milliseconds applied to the head when service moved away. */
  cooldownMs: number
}

/** Durable payload recorded when one request is served by a non-head chain entry. */
export interface LlmFallbackRouteEventData {
  /** Turn containing the routed request. */
  turn: number
  /** Step containing the routed request. */
  step: number
  /** Provider route of the chain head. */
  headProvider: string
  /** Model of the chain head. */
  headModel: string
  /** Provider route that serves the request. */
  provider: string
  /** Model that serves the request. */
  model: string
}
