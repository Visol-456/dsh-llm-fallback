/**
 * Provider fallback chains on the agent loop's request routing and recovery
 * extension points, with a dynamic head: the chain head is the request itself
 * (whatever provider/model the user selected in the harness UI, or the
 * deployment default), and this plugin NEVER rewrites the head. A chain only
 * supplies the fallback targets service moves to after switchable failures,
 * plus the threshold/cooldown rules. Composes with dsh-llm-retry by waterfall
 * order: mount retry first so same-provider retries exhaust before a switch.
 *
 * Mounting with no chains is legal: the plugin stays dormant (requests pass
 * through untouched) until chains are saved from the web UI or written to the
 * settings document, which rebuilds the circuits hot.
 *
 * The same chains are editable from the harness web UI: the plugin registers
 * the `llm-fallback` settings namespace (defaults -> cordis.yml base -> saved
 * user section) and serves a loopback-only config bridge on the web server;
 * a committed settings write rebuilds the circuits hot, next request.
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
import type { FallbackEntry, FallbackMatch, ResolvedFallbackChain } from './circuit.ts'
import type { LlmFallbackEventData, LlmFallbackRouteEventData } from './types.ts'

export { FallbackCircuit } from './circuit.ts'
export type {
  FallbackEntry,
  FallbackMatch,
  FallbackRoute,
  FallbackSwitch,
  FallbackSwitchReason,
  ResolvedFallbackChain,
} from './circuit.ts'
export type { LlmFallbackEventData, LlmFallbackRouteEventData } from './types.ts'

export const name = 'llm-fallback'
export const inject = ['agents']

/** One provider/model route in a fallback chain (a backup target). */
export interface FallbackProviderConfig {
  /** Registered provider route. */
  provider: string
  /** Exact model id served by the route. */
  model: string
}

/** Match condition selecting which requests a chain covers. */
export interface FallbackMatchConfig {
  /** Provider route the request must use. */
  provider: string
  /** Optional exact model; absent matches any model of the provider. */
  model?: string
}

/** One fallback chain: the match condition plus the backup targets and rules. */
export interface FallbackChainConfig {
  /**
   * Match condition; omit to make this the default chain (any request).
   * The request itself is the chain head and is never rewritten.
   */
  match?: FallbackMatchConfig
  /** Ordered backup targets; at least one. */
  fallbacks: FallbackProviderConfig[]
  /** Failure codes eligible to switch; other codes never switch (default: transient failures plus the configuration-error class, e.g. UNKNOWN_MODEL). */
  switchCodes?: string[]
  /** Consecutive eligible failures on the serving entry that open the circuit (default 1). */
  failureThreshold?: number
  /** Milliseconds the head stays excluded before it may be probed again (default 0). */
  cooldownMs?: number
}

/** Plugin config: independent fallback chains. An empty list disables routing. */
export interface Config {
  /** Independent chains; each matches a set of requests. Empty disables routing. */
  chains: FallbackChainConfig[]
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

const matchSchema: z<FallbackMatchConfig> = z.object({
  provider: z.string().required(),
  model: z.string(),
})

const chainSchema = z.object({
  // match is optional: a chain without one is the default chain (any
  // request). The default keeps the field optional in schemastery resolution.
  match: matchSchema.default(undefined as never),
  fallbacks: z.array(providerSchema).min(1),
  switchCodes: z.array(z.string()).default([...DEFAULT_SWITCH_CODES]),
  failureThreshold: z.number().step(1).min(1).default(1),
  cooldownMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(0),
}) as unknown as z<FallbackChainConfig>

/** Runtime schema for {@link Config}. An empty chain list is valid. */
export const Config = z.object({
  chains: z.array(chainSchema).default([]),
}) as unknown as z<Config>

const CHAIN_KEYS: ReadonlySet<string> = new Set([
  'match',
  'fallbacks',
  'switchCodes',
  'failureThreshold',
  'cooldownMs',
])
const PROVIDER_KEYS: ReadonlySet<string> = new Set(['provider', 'model'])

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

/** Validate, default, and detach one chain config. */
function resolveChain(config: FallbackChainConfig, path: string): ResolvedFallbackChain {
  for (const key of Object.keys(config)) {
    if (key === 'providers') {
      throw new Error(
        `${path}.providers is deprecated: the chain head is now the request itself. `
        + 'Use `match` (optional) to select requests and `fallbacks` to list backup targets',
      )
    }
    if (!CHAIN_KEYS.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
  if (!Array.isArray(config.fallbacks) || config.fallbacks.length < 1) {
    throw new Error(`${path}.fallbacks must list at least one provider/model entry`)
  }
  const fallbacks: FallbackEntry[] = []
  config.fallbacks.forEach((entry, index) => {
    const resolved = resolveProvider(entry, `${path}.fallbacks`, index)
    if (fallbacks.some(seen => seen.provider === resolved.provider && seen.model === resolved.model)) {
      throw new Error(`${path}.fallbacks must not repeat provider/model entries`)
    }
    fallbacks.push(resolved)
  })
  let match: FallbackMatch | undefined
  if (config.match !== undefined) {
    if (typeof config.match !== 'object' || config.match === null || Array.isArray(config.match)) {
      throw new Error(`${path}.match must be an object with a provider`)
    }
    if (typeof config.match.provider !== 'string' || config.match.provider.length === 0) {
      throw new Error(`${path}.match.provider must be a non-empty string`)
    }
    if (config.match.model !== undefined
      && (typeof config.match.model !== 'string' || config.match.model.length === 0)) {
      throw new Error(`${path}.match.model must be a non-empty string when present`)
    }
    match = config.match.model === undefined
      ? { provider: config.match.provider }
      : { provider: config.match.provider, model: config.match.model }
  }
  const switchCodes = config.switchCodes ?? [...DEFAULT_SWITCH_CODES]
  if (switchCodes.length === 0) throw new Error(`${path}.switchCodes must not be empty`)
  if (switchCodes.some(code => typeof code !== 'string' || code.length === 0)) {
    throw new Error(`${path}.switchCodes must contain only non-empty strings`)
  }
  if (new Set(switchCodes).size !== switchCodes.length) {
    throw new Error(`${path}.switchCodes must not contain duplicates`)
  }
  const failureThreshold = config.failureThreshold ?? 1
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1) {
    throw new Error(`${path}.failureThreshold must be a positive safe integer`)
  }
  const cooldownMs = config.cooldownMs ?? 0
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0 || cooldownMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.cooldownMs must be a finite number within 0..${MAX_TIMER_DELAY_MS}`)
  }
  return Object.freeze({
    match,
    fallbacks: Object.freeze(fallbacks.map(entry => Object.freeze({ ...entry }))),
    switchCodes: Object.freeze([...switchCodes]),
    failureThreshold,
    cooldownMs,
  })
}

/**
 * Validate the plugin config in full, then detach every chain.
 * An empty (or absent) chain list is valid and returns no circuits, so the
 * plugin mounts dormant until chains are configured. Non-empty lists keep the
 * full cross-field validation: at most one default chain (no match), each
 * chain has >= 1 fallback, no duplicate or shared fallback entries, non-empty
 * codes, in-range numbers.
 */
export function resolveConfig(config: Config): ResolvedFallbackChain[] {
  const raw = Array.isArray(config.chains) ? config.chains : []
  const chains = raw.map((chain, index) =>
    resolveChain(chain, `llm-fallback: chains[${index}]`))
  let defaultSeen = false
  const seen = new Set<string>()
  for (const chain of chains) {
    if (chain.match === undefined) {
      if (defaultSeen) {
        throw new Error('llm-fallback: at most one default chain (a chain without match) is allowed')
      }
      defaultSeen = true
    }
    for (const entry of chain.fallbacks) {
      const key = `${entry.provider}\u0000${entry.model}`
      if (seen.has(key)) {
        throw new Error(
          `llm-fallback: chains must not share fallback entries (${entry.provider}, ${entry.model})`,
        )
      }
      seen.add(key)
    }
  }
  return chains
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
 * Install provider fallback chains on request routing and recovery.
 * @param ctx - plugin context that owns the listeners and circuit state.
 * @param config - chain configuration; validated in full at load.
 * @param internals - non-serializable deterministic hooks for tests.
 */
export function apply(ctx: Context, config: Config, internals: FallbackInternals = {}): void {
  const now = internals.now ?? Date.now

  // Live routing state: the circuits under service plus the attribution map.
  // A committed settings change rebuilds the circuits in place, so every
  // listener observes the new chain on its next request; the attribution
  // map resets with the rebuild (config change is an explicit user action,
  // and in-flight requests already dispatched on the old config finish
  // against it without charging the new one).
  const state = {
    circuits: resolveConfig(config).map(chain => new FallbackCircuit(chain, now)),
    routed: new Map<string, FallbackCircuit>(),
  }
  const rebuild = (next: Config): void => {
    state.circuits = resolveConfig(next).map(chain => new FallbackCircuit(chain, now))
    state.routed.clear()
  }

  // Which chain routed the latest request at each (agent, turn, step).
  // Attribution follows the routing decision: a request is charged to — and
  // only to — the chain that actually routed it, so chains that share a
  // provider (as different models) can neither switch nor reset each other.
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
    // Dormant mode: no chains configured, nothing routes or records.
    if (state.circuits.length === 0) return next()
    const proposed = await next()
    if (signal.aborted) return proposed
    const key = routeKey(agent.id, turn, step)

    // Retried request of a request already routed this step: stay on the
    // circuit that owns it (its switch marker serves the active fallback).
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

    // New request: match the first chain whose condition fits. The request
    // itself is the head — the proposed config is returned unchanged.
    for (const circuit of state.circuits) {
      if (!circuit.matches(proposed.provider, proposed.model)) continue
      const routedRequest = circuit.route(agent.id, turn, step, proposed)
      forgetAgent(agent.id)
      routed.set(key, circuit)
      if (routedRequest.fallback) {
        const routeEvent: LlmFallbackRouteEventData = {
          turn,
          step,
          headProvider: proposed.provider,
          headModel: proposed.model,
          provider: routedRequest.entry.provider,
          model: routedRequest.entry.model,
        }
        agent.session.append('llm/fallback-route', routeEvent)
      }
      return rewrite(proposed, routedRequest.entry)
    }
    return proposed
  })

  ctx.on('agent/request-error', async (
    { agent, turn, step, provider, failure, signal },
    next: () => Promise<RequestErrorAction>,
  ) => {
    if (signal.aborted) return next()
    // Dormant mode: no chains configured, nothing to switch or record.
    if (state.circuits.length === 0) return next()
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
  // rebuilds the circuits hot (next request). Without a settings provider
  // the plugin keeps running from the entry exactly as before.
  let source: () => Config = () => config
  installSettingsSection(ctx, FALLBACK_SETTINGS_NAMESPACE, Config, config, {
    setSource: (current) => { source = current },
    onChange: () => { rebuild(source()) },
    // Cross-field constraints the schema cannot express (duplicate or shared
    // fallbacks, multiple default chains): a write that would strand the
    // owner is refused at the seam instead of stored.
    validate: (value) => { resolveConfig(value) },
  })

  // Browser config bridge, only when a web server is mounted.
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => registerConfigBridge(sctx), 'llm-fallback: config bridge')
  })
}
