/**
 * Provider fallback chains on the agent loop's request routing and recovery
 * extension points: when the serving provider fails with a switchable code
 * (or enough consecutive switchable failures), the same request is retried
 * on the next configured (provider, model) entry, and later requests keep
 * using the chain's serving entry until its cooldown expires and a probe
 * succeeds. Composes with dsh-llm-retry by waterfall order: mount retry
 * first so same-provider retries exhaust before a switch.
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

/** One provider/model route in a fallback chain. */
export interface FallbackProviderConfig {
  /** Registered provider route. */
  provider: string
  /** Exact model id served by the route. */
  model: string
}

/** One fallback chain: ordered service entries plus the switch conditions. */
export interface FallbackChainConfig {
  /** Service priority order; the first entry is the chain head. */
  providers: FallbackProviderConfig[]
  /** Failure codes eligible to switch; other codes never switch (default: transient failures plus the configuration-error class, e.g. UNKNOWN_MODEL). */
  switchCodes?: string[]
  /** Consecutive eligible failures on the serving entry that open the circuit (default 1). */
  failureThreshold?: number
  /** Milliseconds a switched-away entry stays excluded before it may be probed again (default 0). */
  cooldownMs?: number
}

/** Plugin config: independent fallback chains. An empty list disables routing. */
export interface Config {
  /** Independent chains; each is keyed on its head entry. Empty disables routing. */
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

const chainSchema = z.object({
  providers: z.array(providerSchema).min(2),
  switchCodes: z.array(z.string()).default([...DEFAULT_SWITCH_CODES]),
  failureThreshold: z.number().step(1).min(1).default(1),
  cooldownMs: z.number().min(0).max(MAX_TIMER_DELAY_MS).default(0),
}) as unknown as z<FallbackChainConfig>

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  chains: z.array(chainSchema).default([]),
}) as unknown as z<Config>

const CHAIN_KEYS: ReadonlySet<string> = new Set([
  'providers',
  'switchCodes',
  'failureThreshold',
  'cooldownMs',
])
const PROVIDER_KEYS: ReadonlySet<string> = new Set(['provider', 'model'])

/** Validate, default, and detach one chain config. */
function resolveChain(config: FallbackChainConfig, path: string): ResolvedFallbackChain {
  for (const key of Object.keys(config)) {
    if (!CHAIN_KEYS.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
  if (!Array.isArray(config.providers) || config.providers.length < 2) {
    throw new Error(`${path}.providers must list at least two provider/model entries`)
  }
  const entries: FallbackEntry[] = []
  let providerIndex = 0
  for (const entry of config.providers) {
    for (const key of Object.keys(entry)) {
      if (!PROVIDER_KEYS.has(key)) {
        throw new Error(`${path}.providers[${providerIndex}]: unknown key "${key}"`)
      }
    }
    if (typeof entry.provider !== 'string' || entry.provider.length === 0) {
      throw new Error(`${path}.providers[${providerIndex}].provider must be a non-empty string`)
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      throw new Error(`${path}.providers[${providerIndex}].model must be a non-empty string`)
    }
    if (entries.some(seen => seen.provider === entry.provider && seen.model === entry.model)) {
      throw new Error(`${path}.providers must not repeat provider/model entries`)
    }
    entries.push({ provider: entry.provider, model: entry.model })
    providerIndex += 1
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
    entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
    switchCodes: Object.freeze([...switchCodes]),
    failureThreshold,
    cooldownMs,
  })
}

/**
 * Validate the plugin config in full, then detach every chain.
 * An empty (or absent) chain list is valid and returns no circuits, so the
 * plugin mounts dormant until chains are configured. Non-empty lists keep the
 * full cross-field validation (each chain >= 2 entries, no duplicate or
 * shared (provider, model) entries, non-empty codes, in-range numbers).
 */
export function resolveConfig(config: Config): ResolvedFallbackChain[] {
  const raw = Array.isArray(config.chains) ? config.chains : []
  const chains = raw.map((chain, index) =>
    resolveChain(chain, `llm-fallback: chains[${index}]`))
  // Every provider/model entry belongs to exactly one chain, so a request
  // matches at most one chain and a chain can never route another chain's
  // request; duplicate heads are the duplicate-entry special case.
  const seen = new Set<string>()
  for (const chain of chains) {
    for (const entry of chain.entries) {
      const key = `${entry.provider}\u0000${entry.model}`
      if (seen.has(key)) {
        throw new Error(
          `llm-fallback: chains must not share provider/model entries (${entry.provider}, ${entry.model})`,
        )
      }
      seen.add(key)
    }
  }
  return chains
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
    for (const circuit of state.circuits) {
      const routedRequest = circuit.route(agent.id, turn, step, proposed)
      if (routedRequest === undefined) continue
      forgetAgent(agent.id)
      routed.set(routeKey(agent.id, turn, step), circuit)
      const head = circuit.head()
      const changed = routedRequest.entry.provider !== proposed.provider
        || routedRequest.entry.model !== proposed.model
      // Reasoning effort resolves against the head model's capability; the
      // serving adapter re-resolves its own defaults for the switched entry.
      // Everything else on the config rides along, including any future
      // provider-neutral field.
      const { reasoningEffort: _headEffort, ...preserved } = proposed
      const rewritten: LlmCallConfig = changed
        ? { ...preserved, provider: routedRequest.entry.provider, model: routedRequest.entry.model }
        : proposed
      if (routedRequest.fallback) {
        const routeEvent: LlmFallbackRouteEventData = {
          turn,
          step,
          headProvider: head.provider,
          headModel: head.model,
          provider: rewritten.provider,
          model: rewritten.model,
        }
        agent.session.append('llm/fallback-route', routeEvent)
      }
      return rewritten
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
    circuit.recordSuccess(event.data.message.source.provider)
  }, { global: true })

  // Settings seam: the cordis.yml entry is the composition `base`, the
  // browser bridge writes the user section, and every committed change
  // rebuilds the circuits hot (next request). Without a settings provider
  // the plugin keeps running from the entry exactly as before.
  let source: () => Config = () => config
  installSettingsSection(ctx, FALLBACK_SETTINGS_NAMESPACE, Config, config, {
    setSource: (current) => { source = current },
    onChange: () => { rebuild(source()) },
    // Cross-field constraints the schema cannot express (duplicate entries,
    // shared entries across chains): a write that would strand the owner is
    // refused at the seam instead of stored.
    validate: (value) => { resolveConfig(value) },
  })

  // Browser config bridge, only when a web server is mounted.
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => registerConfigBridge(sctx), 'llm-fallback: config bridge')
  })
}
