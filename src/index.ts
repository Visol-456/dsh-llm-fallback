/**
 * Global provider fallback on the agent loop's request routing and recovery
 * extension points, with a dynamic head: the head is the request itself
 * (whatever provider/model the user selected in the harness UI, or the
 * deployment default), and this plugin NEVER rewrites the head. After a
 * switchable failure the same request retries on the configured fallbacks in
 * order. Composes with dsh-llm-retry by waterfall order: mount retry first so
 * same-provider retries exhaust before a switch.
 *
 * Mounting with no fallbacks is legal: the plugin stays dormant (requests pass
 * through untouched) until fallbacks are saved from the web UI or written to
 * the settings document, which rebuilds the circuit hot.
 *
 * The same fallbacks are editable from the harness web UI: the plugin
 * registers the `llm-fallback` settings namespace (defaults -> cordis.yml base
 * -> saved user section) and serves a loopback-only config bridge on the web
 * server; a committed settings write rebuilds the circuit hot, next request.
 *
 * @module @deepseek-ai/dsh-llm-fallback
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only: pulls the `ctx.webServer` Context merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { registerConfigBridge } from './config-http.ts'
import { FallbackCircuit } from './circuit.ts'
import type { FallbackEntry, ResolvedFallbackChain } from './circuit.ts'
import type { LlmFallbackEventData, LlmFallbackRouteEventData } from './types.ts'

export { FallbackCircuit } from './circuit.ts'
export type {
  FallbackEntry,
  FallbackRoute,
  FallbackSwitch,
  FallbackSwitchReason,
  ResolvedFallbackChain,
} from './circuit.ts'
export type { LlmFallbackEventData, LlmFallbackRouteEventData } from './types.ts'

export const name = 'llm-fallback'
export const inject = ['agents']

/** One provider/model route in the fallback list (a backup target). */
export interface FallbackProviderConfig {
  /** Registered provider route. */
  provider: string
  /** Exact model id served by the route. */
  model: string
}

/** Plugin config: the global fallback list plus the switch rules. */
export interface Config {
  /** Ordered backup targets; the request itself is always the head. Absent = dormant. */
  fallbacks?: FallbackProviderConfig[]
  /** Failure codes eligible to switch; other codes never switch (default: transient failures plus the configuration-error class, e.g. UNKNOWN_MODEL). */
  switchCodes?: string[]
  /** Consecutive eligible failures on the head (or a fallback) that open the circuit (default 1). */
  failureThreshold?: number
  /** Milliseconds the head stays excluded before it may be probed again (default 0). */
  cooldownMs?: number
}

/** Settings namespace carrying GUI-saved fallback chains. */
export const FALLBACK_SETTINGS_NAMESPACE = settingsNamespace('llm-fallback')

/** Default failure codes eligible to switch: transient failures plus the
 * configuration-error class (a mistyped model id), so a wrong model also
 * fails the request over to the next (usually correctly configured) entry. */
export const DEFAULT_SWITCH_CODES: readonly string[] = Object.freeze([
  EMPTY_RESPONSE_CODE,
  'RATE_LIMIT',
  'SERVER',
  'UNKNOWN_MODEL',
  'TIMEOUT',
  'TRANSPORT',
])

const providerSchema: z<FallbackProviderConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
})

/** Runtime schema for {@link Config}. An absent fallback list is dormant. */
export const Config = z.object({
  // `fallbacks` is optional at the schema layer: absent stays absent so an
  // empty (dormant) config resolves cleanly. The non-empty check lives in
  // resolveConfig, which also owns the deprecation errors.
  fallbacks: z.array(providerSchema).min(1).default(undefined as never),
  switchCodes: z.array(z.string()).default([...DEFAULT_SWITCH_CODES]),
  failureThreshold: z.number().step(1).min(1).default(1),
  cooldownMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(0),
}) as unknown as z<Config>

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'fallbacks',
  'switchCodes',
  'failureThreshold',
  'cooldownMs',
])
const PROVIDER_KEYS: ReadonlySet<string> = new Set(['provider', 'model'])
/** Old-config keys rejected with a migration hint. */
const DEPRECATED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  chains: 'use the top-level `fallbacks` list (the old per-chain match/fallbacks shape is gone)',
  match: 'the head is always the request itself; there is no per-chain match anymore',
  providers: 'the head is always the request itself; move the old first entry\'s provider/model into the top-level `fallbacks` list',
})

/** Validate one fallback entry object. */
function resolveProvider(
  entry: FallbackProviderConfig,
  path: string,
  index: number,
): FallbackEntry {
  for (const key of Object.keys(entry)) {
    if (!PROVIDER_KEYS.has(key)) {
      throw new Error(`${path}[${index}]: unknown key "${key}"`)
    }
  }
  if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
    throw new Error(`${path}[${index}].provider must be a non-empty string`)
  }
  if (typeof entry.model !== 'string' || entry.model.length === 0) {
    throw new Error(`${path}[${index}].model must be a non-empty string`)
  }
  return { provider: entry.provider, model: entry.model }
}

/**
 * Validate the plugin config and detach the fallback list.
 * An absent (or undefined) fallback list is valid and returns undefined, so
 * the plugin mounts dormant until fallbacks are configured. A present but
 * empty list, duplicates, malformed entries, and the old `chains`/`match`/
 * `providers` keys all fail loud.
 */
export function resolveConfig(config: Config): ResolvedFallbackChain | undefined {
  for (const key of Object.keys(config)) {
    if (CONFIG_KEYS.has(key)) continue
    const hint = DEPRECATED_KEYS[key]
    if (hint !== undefined) {
      throw new Error(`llm-fallback: "${key}" is deprecated - ${hint}`)
    }
    throw new Error(`llm-fallback: unknown key "${key}"`)
  }
  if (config.fallbacks === undefined) return undefined
  if (!Array.isArray(config.fallbacks) || config.fallbacks.length < 1) {
    throw new Error('llm-fallback: fallbacks must list at least one provider/model entry')
  }
  const fallbacks: FallbackEntry[] = []
  config.fallbacks.forEach((entry, index) => {
    const resolved = resolveProvider(entry, 'llm-fallback: fallbacks', index)
    if (fallbacks.some(seen => seen.provider === resolved.provider && seen.model === resolved.model)) {
      throw new Error('llm-fallback: fallbacks must not repeat provider/model entries')
    }
    fallbacks.push(resolved)
  })
  const switchCodes = config.switchCodes ?? [...DEFAULT_SWITCH_CODES]
  if (switchCodes.length === 0) throw new Error('llm-fallback: switchCodes must not be empty')
  if (switchCodes.some(code => typeof code !== 'string' || code.length === 0)) {
    throw new Error('llm-fallback: switchCodes must contain only non-empty strings')
  }
  if (new Set(switchCodes).size !== switchCodes.length) {
    throw new Error('llm-fallback: switchCodes must not contain duplicates')
  }
  const failureThreshold = config.failureThreshold ?? 1
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1) {
    throw new Error('llm-fallback: failureThreshold must be a positive safe integer')
  }
  const cooldownMs = config.cooldownMs ?? 0
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0 || cooldownMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-fallback: cooldownMs must be a finite number within 0..${MAX_TIMER_DELAY_MS}`)
  }
  return Object.freeze({
    fallbacks: Object.freeze(fallbacks.map(entry => Object.freeze({ ...entry }))),
    switchCodes: Object.freeze([...switchCodes]),
    failureThreshold,
    cooldownMs,
  })
}

/** Rewrite a config onto a fallback entry, preserving provider-neutral fields. */
function rewrite(proposed: LlmCallConfig, entry: FallbackEntry): LlmCallConfig {
  const changed = entry.provider !== proposed.provider || entry.model !== proposed.model
  if (!changed) return proposed
  // Reasoning effort resolves against the head model's capability; the
  // serving adapter re-resolves its own defaults for the switched entry.
  // Everything else on the config rides along, including any future
  // provider-neutral field.
  const { reasoningEffort: _headEffort, ...preserved } = proposed
  return { ...preserved, provider: entry.provider, model: entry.model }
}

/** Non-serializable hooks that make timing policy deterministic in tests. */
export interface FallbackInternals {
  /** Clock returning the current time in milliseconds (defaults to Date.now). */
  now?: () => number
}

/**
 * Install provider fallback on request routing and recovery.
 * @param ctx - plugin context that owns the listeners and circuit state.
 * @param config - chain configuration; validated in full at load.
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config, internals: FallbackInternals = {}): void {
  const now = internals.now ?? Date.now

  // Live routing state: the single circuit (undefined = dormant) plus the
  // attribution map. A committed settings change rebuilds the circuit in
  // place, so every listener observes the new fallbacks on its next request;
  // the attribution map resets with the rebuild.
  const state = {
    circuit: buildCircuit(config),
    routed: new Map<string, FallbackCircuit>(),
  }
  function buildCircuit(cfg: Config): FallbackCircuit | undefined {
    const resolved = resolveConfig(cfg)
    return resolved === undefined ? undefined : new FallbackCircuit(resolved, now)
  }
  const rebuild = (next: Config): void => {
    state.circuit = buildCircuit(next)
    state.routed.clear()
  }

  // Which step's retry is pinned to the fallback that consumed its switch.
  // Attribution follows the routing decision: only requests that routed
  // through the circuit can switch or be charged.
  const routed = state.routed
  const routeKey = (agent: string, turn: number, step: number): string =>
    `${agent}\u0000${turn}\u0000${step}`
  // A step's request-error and assistant message settle before the agent's
  // next request routes, so every older key for the agent is dead by then.
  const forgetAgent = (agent: string): void => {
    const prefix = `${agent}\u0000`
    for (const key of routed.keys()) {
      if (key.startsWith(prefix)) routed.delete(key)
    }
  }

  ctx.on('agent/request', async (
    { agent, turn, step, signal },
    next: () => Promise<LlmCallConfig>,
  ) => {
    // Dormant mode: no fallbacks configured, nothing routes or records.
    if (state.circuit === undefined) return next()
    const proposed = await next()
    if (signal.aborted) return proposed
    const key = routeKey(agent.id, turn, step)

    // Retried request of a request already routed this step: stay on the
    // circuit (its switch marker serves the active fallback).
    const existing = routed.get(key)
    if (existing !== undefined) {
      const routedRequest = existing.route(agent.id, turn, step, proposed)
      if (routedRequest.fallback) {
        const head = existing.head()
        const routeEvent: LlmFallbackRouteEventData = {
          turn,
          step,
          headProvider: head.provider,
          headModel: head.model,
          provider: routedRequest.entry.provider,
          model: routedRequest.entry.model,
        }
        agent.session.append('llm/fallback-route', routeEvent)
      }
      return rewrite(proposed, routedRequest.entry)
    }

    // New request: it is the head - record it and return the proposed config
    // untouched (the plugin never rewrites the head).
    state.circuit.route(agent.id, turn, step, proposed)
    forgetAgent(agent.id)
    routed.set(key, state.circuit)
    return proposed
  })

  ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure, signal },
    next: () => Promise<RequestErrorAction>,
  ) => {
    if (signal.aborted) return next()
    // Dormant mode: no fallbacks configured, nothing to switch or record.
    if (state.circuit === undefined) return next()
    const circuit = routed.get(routeKey(agent.id, turn, step))
    if (circuit === undefined) return next()
    const decision = circuit.recordFailure(agent.id, turn, step, provider, failure)
    if (decision === undefined) return next()
    const head = circuit.head()
    const eventData: LlmFallbackEventData = {
      turn,
      step,
      headProvider: head.provider,
      headModel: head.model,
      fromProvider: decision.from.provider,
      fromModel: decision.from.model,
      toProvider: decision.to.provider,
      toModel: decision.to.model,
      reason: decision.reason,
      failure,
      cooldownMs: circuit.cooldownMs(),
    }
    agent.session.append('llm/fallback', eventData)
    return { kind: 'retry' }
  })

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'assistant/message') return
    const key = routeKey(session.id, event.data.turn, event.data.step)
    const circuit = routed.get(key)
    if (circuit === undefined) return
    routed.delete(key)
    circuit.recordSuccess(
      event.data.message.source.provider,
      event.data.message.source.model,
    )
  }, { global: true })

  // Settings seam: the cordis.yml entry is the composition `base`, the
  // browser bridge writes the user section, and every committed change
  // rebuilds the circuit hot (next request). Without a settings provider the
  // plugin keeps running from the entry exactly as before.
  let source: () => Config = () => config
  installSettingsSection(ctx, FALLBACK_SETTINGS_NAMESPACE, Config, config, {
    setSource: (current) => { source = current },
    onChange: () => { rebuild(source()) },
    // Cross-field constraints the schema cannot express (empty list, duplicate
    // entries, deprecated keys): a write that would strand the owner is
    // refused at the seam instead of stored.
    validate: (value) => { resolveConfig(value) },
  })

  // Browser config bridge, only when a web server is mounted.
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => registerConfigBridge(sctx), 'llm-fallback: config bridge')
  })
}
