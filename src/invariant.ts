/** Package-owned durable fallback-event invariants. @module @deepseek-ai/dsh-llm-fallback/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-fallback'

/** Cordis companion plugin name. */
export const name = 'llm-fallback-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the complete provider-neutral failure payload at the durable boundary. */
function validateFailure(value: unknown, fail: InvariantFailure): asserts value is LlmFailure {
  if (typeof value !== 'object' || value === null) {
    fail('llm/fallback failure must be an object')
  }
  const failure = value as Partial<LlmFailure>
  if (typeof failure.message !== 'string' || failure.message.length === 0) {
    fail('llm/fallback failure.message must be a non-empty string')
  }
  if (typeof failure.code !== 'string' || failure.code.length === 0) {
    fail('llm/fallback failure.code must be a non-empty string')
  }
  if (failure.status !== undefined
    && (!Number.isInteger(failure.status) || failure.status < 100 || failure.status > 599)) {
    fail('llm/fallback failure.status must be an integer from 100 through 599 when present')
  }
  if (failure.providerRetryAfterMs !== undefined
    && (!Number.isFinite(failure.providerRetryAfterMs) || failure.providerRetryAfterMs <= 0)) {
    fail('llm/fallback failure.providerRetryAfterMs must be a positive finite number when present')
  }
  if (failure.requestId !== undefined
    && (typeof failure.requestId !== 'string' || failure.requestId.length === 0)) {
    fail('llm/fallback failure.requestId must be a non-empty string when present')
  }
}

/** Validate one non-empty entry pair in a fallback event payload. */
function validateEntry(
  label: string,
  provider: unknown,
  model: unknown,
  fail: InvariantFailure,
): void {
  if (typeof provider !== 'string' || provider.length === 0) {
    fail(`${label} provider must be a non-empty string`)
  }
  if (typeof model !== 'string' || model.length === 0) {
    fail(`${label} model must be a non-empty string`)
  }
}

/** Validate that an event names the currently open turn and step. */
function validateOpenStep(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/fallback'> | SessionEvent<'llm/fallback-route'>,
  label: string,
  fail: InvariantFailure,
): void {
  const { turn, step } = event.data
  const turnBoundary = history.findLast(prior =>
    prior.type === 'turn/start' || prior.type === 'turn/end')
  if (turnBoundary?.type !== 'turn/start') {
    fail(`${label} must be appended inside an open turn`)
  }
  if (turn !== turnBoundary.data.turn) {
    fail(`${label} names turn ${turn}, but the open turn is ${turnBoundary.data.turn}`)
  }
  const stepBoundary = history.findLast(prior =>
    prior.type === 'step/start' || prior.type === 'step/end')
  if (stepBoundary?.type !== 'step/start') {
    fail(`${label} must be appended inside an open step`)
  }
  if (step !== stepBoundary.data.step || turn !== stepBoundary.data.turn) {
    fail(`${label} names turn ${turn}/step ${step}, but the open step is ${stepBoundary.data.turn}/${stepBoundary.data.step}`)
  }
}

/** Validate one switch record against the currently open request step. */
function validateSwitch(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/fallback'>,
  fail: InvariantFailure,
): void {
  const {
    headProvider,
    headModel,
    fromProvider,
    fromModel,
    toProvider,
    toModel,
    reason,
    cooldownMs,
  } = event.data
  validateEntry('llm/fallback head', headProvider, headModel, fail)
  validateEntry('llm/fallback from', fromProvider, fromModel, fail)
  validateEntry('llm/fallback to', toProvider, toModel, fail)
  if (fromProvider === toProvider && fromModel === toModel) {
    fail('llm/fallback must switch to a different entry')
  }
  switch (reason) {
    case 'threshold':
    case 'probe':
      break
    default:
      fail(`llm/fallback reason must be threshold or probe, got ${String(reason)}`)
  }
  if (typeof cooldownMs !== 'number' || !Number.isFinite(cooldownMs)
    || cooldownMs < 0 || cooldownMs > MAX_TIMER_DELAY_MS) {
    fail(`llm/fallback cooldownMs must be a finite number within 0..${MAX_TIMER_DELAY_MS}`)
  }
  validateFailure(event.data.failure, fail)
  validateOpenStep(history, event, 'llm/fallback', fail)
}

/** Validate one routed-request record against the currently open request step. */
function validateRoute(
  history: readonly SessionEvent[],
  event: SessionEvent<'llm/fallback-route'>,
  fail: InvariantFailure,
): void {
  validateEntry('llm/fallback-route head', event.data.headProvider, event.data.headModel, fail)
  validateEntry('llm/fallback-route', event.data.provider, event.data.model, fail)
  validateOpenStep(history, event, 'llm/fallback-route', fail)
}

/** Validate every fallback record already present in one loaded session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    if (event.type === 'llm/fallback') validateSwitch(session.events.slice(0, index), event, fail)
    else if (event.type === 'llm/fallback-route') validateRoute(session.events.slice(0, index), event, fail)
  }
}

/** Install validation for loaded and newly appended fallback records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'llm/fallback') validateSwitch(session.events, event, fail)
    else if (event.type === 'llm/fallback-route') validateRoute(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the LLM fallback invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
