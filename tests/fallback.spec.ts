import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { NormalRetryPolicyConfig, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import * as fallback from '../src/index.ts'
import type { FallbackChainConfig } from '../src/index.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly scripts: Map<string, ScriptEntry[]>
  private reasoning = new Set<string>()
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(scripts: Record<string, readonly ScriptEntry[]>) {
    super()
    this.scripts = new Map(Object.entries(scripts).map(([provider, script]) => [provider, [...script]]))
  }

  /** Declare providers whose exact models advertise reasoning support. */
  configureReasoning(providers: readonly string[]): void {
    this.reasoning = new Set(providers)
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `fallback test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (!this.reasoning.has(provider)) return { provider, id: model, name: model }
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('high'),
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const script = this.scripts.get(options.provider)
    if (script === undefined) throw new Error(`no script for provider "${options.provider}"`)
    const entry = script.shift()
    if (entry === undefined) throw new Error(`script exhausted for provider "${options.provider}"`)
    if (entry instanceof Error) throw entry
    yield* entry
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function normalConfig(
  overrides: Partial<Omit<NormalRetryPolicyConfig, 'mode'>> = {},
): NormalRetryPolicyConfig {
  const { backoff, ...policy } = overrides
  return {
    mode: 'normal',
    maxRetries: 2,
    ...policy,
    backoff: {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0,
      ...backoff,
    },
  }
}

function chain(overrides: Partial<FallbackChainConfig> = {}): FallbackChainConfig {
  const { fallbacks, match, ...rest } = overrides
  return {
    match,
    fallbacks: fallbacks ?? [{ provider: 'other', model: 'other' }],
    ...rest,
  }
}

async function harness(
  adapter: ScriptedAdapter,
  config: fallback.Config,
  options: {
    /** Providers registered on the adapter; the head may be withheld for NO_ADAPTER tests. */
    providers?: string[]
    /** Mount dsh-llm-retry first with these per-provider policies. */
    retryPolicies?: Readonly<Record<string, RetryPolicyConfig | undefined>>
    /** Deterministic clock for cooldown tests. */
    now?: () => number
    /** Re-assert one provider/model on every request (mirrors the harness
     * model-selection listener the web UI installs, so the head is the user's
     * selection even after the loop persisted a switched config). */
    selection?: { provider: string; model: string }
    beforeMount?: (ctx: Context) => void
  } = {},
): Promise<{ ctx: Context; fallbackFiber: { dispose(): Promise<void> }; disposeAdapter: () => void }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  options.beforeMount?.(ctx)
  if (options.retryPolicies !== undefined) {
    adapter.configureRetryPolicies(options.retryPolicies)
    await ctx.plugin(Object.assign((inner: Context) => {
      retry.apply(inner, {})
    }, { inject: retry.inject }))
  }
  const fallbackFiber = await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, config, options.now === undefined ? {} : { now: options.now })
  }, { inject: fallback.inject }))
  // Registered after the fallback plugin, exactly like the harness's
  // model-selection listener: it re-asserts the user's head on the proposed
  // config that the fallback handler sees.
  if (options.selection !== undefined) {
    const selection = options.selection
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: selection.provider, model: selection.model }
    })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const disposeAdapter = ctx.llm.registerAdapter(options.providers ?? ['mock', 'other'], adapter)
  return { ctx, fallbackFiber: { dispose: () => fallbackFiber.dispose() }, disposeAdapter }
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function send(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  return idle
}

function assistantText(agent: Agent): string | undefined {
  const message = agent.session.deriveMessages().at(-1)
  if (message?.role !== 'assistant') return undefined
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

describe('provider fallback chains', () => {
  it('requires chains in the config type', () => {
    expectTypeOf<{ chains: FallbackChainConfig[] }>().toExtend<fallback.Config>()
    expectTypeOf<{}>().not.toExtend<fallback.Config>()
  })

  it('serves the head while it is healthy without recording any fallback event', async () => {
    const adapter = new ScriptedAdapter({ mock: [textResponse('primary')] })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }))
    const agent = context.agentLoop.create(SessionId('fallback-healthy'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => [request.provider, request.model]))
      .toEqual([['mock', 'mock']])
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    expect(agent.session.events.some(event => event.type === 'llm/fallback-route')).toBe(false)
    expect(assistantText(agent)).toBe('primary')
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
  })

  it('matches a chain by provider alone when match.model is omitted', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('one down', 'SERVER'), new LlmError('two down', 'SERVER')],
      other: [textResponse('one recovered'), textResponse('two recovered')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ match: { provider: 'mock' } })],
    }, { providers: ['mock', 'other'] }))
    const modelOne = context.agentLoop.create(SessionId('fallback-provider-match-one'), {
      provider: 'mock',
      model: 'model-one',
    })
    const modelTwo = context.agentLoop.create(SessionId('fallback-provider-match-two'), {
      provider: 'mock',
      model: 'model-two',
    })

    await send(context, modelOne, 'go')
    await send(context, modelTwo, 'go')

    expect(adapter.requests.map(request => [request.provider, request.model]))
      .toEqual([
        ['mock', 'model-one'],
        ['other', 'other'],
        ['mock', 'model-two'],
        ['other', 'other'],
      ])
    expect(modelOne.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(modelTwo.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(assistantText(modelOne)).toBe('one recovered')
    expect(assistantText(modelTwo)).toBe('two recovered')
  })

  it('mounts with no chains and lets every request pass through untouched', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('busy', 'SERVER')],
      other: [textResponse('should not be reached')],
    })
    // Empty chain list is valid: the plugin stays dormant.
    ;({ ctx: context } = await harness(adapter, { chains: [] }))
    const agent = context.agentLoop.create(SessionId('fallback-dormant'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    // No routing, no switch, no events: the failing provider surfaces normally.
    expect(adapter.requests.map(request => request.provider)).toEqual(['mock'])
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    expect(agent.session.events.some(event => event.type === 'llm/fallback-route')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })
  })

  it('serves the same request from the next entry after a switchable failure', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('busy', 'SERVER')],
      other: [textResponse('recovered')],
    })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }))
    const agent = context.agentLoop.create(SessionId('fallback-switch'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
    expect(adapter.requests[1]?.messages).toEqual(adapter.requests[0]?.messages)
    const switchEvent = agent.session.events.find(event => event.type === 'llm/fallback')
    expect(switchEvent).toMatchObject({
      data: {
        turn: 1,
        step: 1,
        headProvider: 'mock',
        headModel: 'mock',
        fromProvider: 'mock',
        fromModel: 'mock',
        toProvider: 'other',
        toModel: 'other',
        reason: 'threshold',
        failure: { message: 'busy', code: 'SERVER' },
        cooldownMs: 0,
      },
    })
    const routeEvent = agent.session.events.find(event => event.type === 'llm/fallback-route')
    expect(routeEvent).toMatchObject({
      data: {
        turn: 1,
        step: 1,
        headProvider: 'mock',
        headModel: 'mock',
        provider: 'other',
        model: 'other',
      },
    })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'other', model: 'other' },
    })
    expect(assistantText(agent)).toBe('recovered')
  })

  it('switches on UNKNOWN_MODEL with the default switch codes', async () => {
    // Default switch codes now include the configuration-error class: a
    // mistyped head model (UNKNOWN_MODEL) fails the request over to the next,
    // usually correctly configured, entry instead of ending the turn.
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('unknown model', 'UNKNOWN_MODEL')],
      other: [textResponse('recovered on fallback')],
    })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }))
    const agent = context.agentLoop.create(SessionId('fallback-unknown-model'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
    const switchEvent = agent.session.events.find(event => event.type === 'llm/fallback')
    expect(switchEvent).toMatchObject({
      data: {
        turn: 1,
        step: 1,
        headProvider: 'mock',
        headModel: 'mock',
        fromProvider: 'mock',
        fromModel: 'mock',
        toProvider: 'other',
        toModel: 'other',
        reason: 'threshold',
        failure: { message: 'unknown model', code: 'UNKNOWN_MODEL' },
        cooldownMs: 0,
      },
    })
    expect(agent.session.events.find(event => event.type === 'llm/fallback-route')).toMatchObject({
      data: { provider: 'other', model: 'other' },
    })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'other', model: 'other' },
    })
    expect(assistantText(agent)).toBe('recovered on fallback')
  })

  it('keeps routing later requests to the fallback while the head cooldown runs', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('busy', 'SERVER'), new LlmError('busy', 'SERVER')],
      other: [textResponse('fallback one'), textResponse('fallback two')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ cooldownMs: 60_000 })],
    }, { now: () => 0, selection: { provider: 'mock', model: 'mock' } }))
    const agent = context.agentLoop.create(SessionId('fallback-cooldown'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'first')
    await send(context, agent, 'second')

    // During the head cooldown every request still tries the head first (it
    // is never rewritten), then fails over to the fallback in service.
    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback-route')
      .map(event => [event.data.turn, event.data.provider]))
      .toEqual([[1, 'other'], [2, 'other']])
    expect(assistantText(agent)).toBe('fallback two')
  })

  it('probes the head after its cooldown expires and recovers without route events', async () => {
    let time = 0
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('busy', 'SERVER'), textResponse('primary back')],
      other: [textResponse('fallback')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ cooldownMs: 60_000 })],
    }, { now: () => time, selection: { provider: 'mock', model: 'mock' } }))
    const agent = context.agentLoop.create(SessionId('fallback-recovery'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'first')
    time = 60_001
    await send(context, agent, 'second')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'mock'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback-route')
      .map(event => event.data.turn))
      .toEqual([1])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
    expect(assistantText(agent)).toBe('primary back')
  })

  it('re-opens the circuit on one failed probe regardless of the threshold', async () => {
    let time = 0
    const adapter = new ScriptedAdapter({
      mock: [
        new LlmError('one', 'SERVER'),
        new LlmError('two', 'SERVER'),
        new LlmError('three', 'SERVER'),
        new LlmError('probe', 'SERVER'),
      ],
      other: [textResponse('fallback one'), textResponse('fallback two')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ failureThreshold: 3, cooldownMs: 60_000 })],
    }, { now: () => time, selection: { provider: 'mock', model: 'mock' } }))
    const agent = context.agentLoop.create(SessionId('fallback-probe-reopen'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'first')
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'one', code: 'SERVER' } } },
    })
    await send(context, agent, 'second')
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'two', code: 'SERVER' } } },
    })
    await send(context, agent, 'third')
    expect(assistantText(agent)).toBe('fallback one')

    time = 60_001
    await send(context, agent, 'fourth')

    expect(adapter.requests.map(request => request.provider))
      .toEqual(['mock', 'mock', 'mock', 'other', 'mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')
      .map(event => event.data.reason))
      .toEqual(['threshold', 'probe'])
    expect(assistantText(agent)).toBe('fallback two')
  })

  it('accumulates the threshold from zero again after a successful probe', async () => {
    let time = 0
    const adapter = new ScriptedAdapter({
      mock: [
        new LlmError('busy one', 'SERVER'),
        new LlmError('busy two', 'SERVER'),
        textResponse('probe recovered'),
        new LlmError('busy three', 'SERVER'),
        new LlmError('busy four', 'SERVER'),
      ],
      other: [textResponse('first fallback'), textResponse('second fallback')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ failureThreshold: 2, cooldownMs: 60_000 })],
    }, { now: () => time, selection: { provider: 'mock', model: 'mock' } }))
    const agent = context.agentLoop.create(SessionId('fallback-recovered-threshold'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'first')
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'busy one', code: 'SERVER' } } },
    })
    await send(context, agent, 'second')
    expect(assistantText(agent)).toBe('first fallback')

    time = 60_001
    await send(context, agent, 'third')
    expect(assistantText(agent)).toBe('probe recovered')

    // After the successful probe the head is healthy: the next failure must
    // accumulate against the threshold, not re-open the circuit as a probe.
    await send(context, agent, 'fourth')
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'busy three', code: 'SERVER' } } },
    })
    await send(context, agent, 'fifth')
    expect(assistantText(agent)).toBe('second fallback')

    expect(adapter.requests.map(request => request.provider))
      .toEqual(['mock', 'mock', 'other', 'mock', 'mock', 'mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')
      .map(event => event.data.reason))
      .toEqual(['threshold', 'threshold'])
  })

  it('switches only after consecutive switchable failures reach the threshold', async () => {
    const adapter = new ScriptedAdapter({
      mock: [
        new LlmError('one', 'SERVER'),
        new LlmError('two', 'SERVER'),
        new LlmError('three', 'SERVER'),
      ],
      other: [textResponse('recovered')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ failureThreshold: 2 })],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-threshold'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'first')
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    await send(context, agent, 'second')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(assistantText(agent)).toBe('recovered')
  })

  it('ignores non-switchable failures without counting them toward a switch', async () => {
    const adapter = new ScriptedAdapter({
      mock: [
        new LlmError('bad key', 'AUTH'),
        new LlmError('busy one', 'SERVER'),
        new LlmError('busy two', 'SERVER'),
        new LlmError('busy three', 'SERVER'),
      ],
      other: [textResponse('recovered')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ failureThreshold: 2 })],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-nonswitchable'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'auth')
    await send(context, agent, 'one')
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    await send(context, agent, 'two')

    expect(adapter.requests.map(request => request.provider))
      .toEqual(['mock', 'mock', 'mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    const turnErrors = agent.session.events.filter(event => event.type === 'turn/end')
    expect(turnErrors.map(event => event.data.reason)).toEqual([
      { kind: 'error', error: { message: 'bad key', code: 'AUTH' } },
      { kind: 'error', error: { message: 'busy one', code: 'SERVER' } },
      { kind: 'completed' },
    ])
    expect(assistantText(agent)).toBe('recovered')
  })

  it('resets the consecutive count when the serving entry answers successfully', async () => {
    const adapter = new ScriptedAdapter({
      mock: [
        new LlmError('busy one', 'SERVER'),
        textResponse('fine'),
        new LlmError('busy two', 'SERVER'),
        new LlmError('busy three', 'SERVER'),
      ],
      other: [textResponse('recovered')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ failureThreshold: 2 })],
    }))
    const agent = context.agentLoop.create(SessionId('fallback-success-reset'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'first')
    await send(context, agent, 'second')
    expect(assistantText(agent)).toBe('fine')
    await send(context, agent, 'third')
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    await send(context, agent, 'fourth')

    expect(adapter.requests.map(request => request.provider))
      .toEqual(['mock', 'mock', 'mock', 'mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(assistantText(agent)).toBe('recovered')
  })

  it('exhausts the chain and surfaces the last failure as terminal', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('primary down', 'SERVER')],
      other: [new LlmError('fallback down', 'SERVER')],
    })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }))
    const agent = context.agentLoop.create(SessionId('fallback-exhausted'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'fallback down', code: 'SERVER' } } },
    })
  })

  it('never switches on non-switchable failures', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('bad key', 'AUTH')],
      other: [textResponse('must not run')],
    })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }))
    const agent = context.agentLoop.create(SessionId('fallback-auth'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock'])
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'AUTH' } } },
    })
  })

  it('leaves requests outside the chain and non-head models untouched', async () => {
    const adapter = new ScriptedAdapter({
      mock: [textResponse('reasoner ok'), textResponse('direct ok')],
      unrelated: [textResponse('unrelated ok')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({
        match: { provider: 'mock', model: 'mock' },
        fallbacks: [{ provider: 'other', model: 'other' }],
      })],
    }, { providers: ['mock', 'other', 'unrelated'] }))
    const reasoner = context.agentLoop.create(SessionId('fallback-unmatched-model'), {
      provider: 'mock',
      model: 'reasoner',
    })
    const unrelated = context.agentLoop.create(SessionId('fallback-unmatched-provider'), {
      provider: 'unrelated',
      model: 'anything',
    })

    await send(context, reasoner, 'go')
    await send(context, unrelated, 'go')

    expect(adapter.requests.map(request => [request.provider, request.model]))
      .toEqual([['mock', 'reasoner'], ['unrelated', 'anything']])
    expect(reasoner.session.events.some(event => event.type === 'llm/fallback-route')).toBe(false)
    expect(unrelated.session.events.some(event => event.type === 'llm/fallback-route')).toBe(false)
    expect(assistantText(reasoner)).toBe('reasoner ok')
    expect(assistantText(unrelated)).toBe('unrelated ok')
  })

  it('keeps independent chains independent', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('mock down', 'SERVER')],
      other: [textResponse('other ok')],
      biz: [new LlmError('biz down', 'SERVER')],
      baz: [textResponse('baz ok')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [
        chain({ match: { provider: 'mock', model: 'mock' } }),
        chain({
          match: { provider: 'biz', model: 'biz' },
          fallbacks: [{ provider: 'baz', model: 'baz' }],
        }),
      ],
    }, { providers: ['mock', 'other', 'biz', 'baz'] }))
    const mockAgent = context.agentLoop.create(SessionId('fallback-chain-one'), {
      provider: 'mock',
      model: 'mock',
    })
    const bizAgent = context.agentLoop.create(SessionId('fallback-chain-two'), {
      provider: 'biz',
      model: 'biz',
    })

    await send(context, mockAgent, 'go')
    await send(context, bizAgent, 'go')

    const mockSwitch = mockAgent.session.events.find(event => event.type === 'llm/fallback')
    expect(mockSwitch).toMatchObject({ data: { headProvider: 'mock', toProvider: 'other' } })
    expect(assistantText(mockAgent)).toBe('other ok')
    const bizSwitch = bizAgent.session.events.find(event => event.type === 'llm/fallback')
    expect(bizSwitch).toMatchObject({ data: { headProvider: 'biz', toProvider: 'baz' } })
    expect(assistantText(bizAgent)).toBe('baz ok')
    expect(mockAgent.session.events.some(event =>
      event.type === 'llm/fallback' && event.data.headProvider === 'biz')).toBe(false)
  })

  it('does not charge another chain when two chains share a provider as different models', async () => {
    const adapter = new ScriptedAdapter({
      mock: [
        textResponse('model one ok'),
        new LlmError('model two down', 'SERVER'),
        textResponse('model one still ok'),
      ],
      other: [textResponse('other ok')],
      biz: [textResponse('biz ok')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [
        chain({
          match: { provider: 'mock', model: 'model-one' },
          fallbacks: [{ provider: 'other', model: 'other' }],
        }),
        chain({
          match: { provider: 'mock', model: 'model-two' },
          fallbacks: [{ provider: 'biz', model: 'biz' }],
        }),
      ],
    }, { providers: ['mock', 'other', 'biz'] }))
    const modelOne = context.agentLoop.create(SessionId('fallback-shared-provider-one'), {
      provider: 'mock',
      model: 'model-one',
    })
    const modelTwo = context.agentLoop.create(SessionId('fallback-shared-provider-two'), {
      provider: 'mock',
      model: 'model-two',
    })

    await send(context, modelOne, 'go')
    expect(assistantText(modelOne)).toBe('model one ok')
    await send(context, modelTwo, 'go')
    expect(assistantText(modelTwo)).toBe('biz ok')
    await send(context, modelOne, 'go')

    // The failure of model-two switched only its own chain; model-one's chain
    // kept serving from the shared provider.
    expect(adapter.requests.map(request => [request.provider, request.model]))
      .toEqual([
        ['mock', 'model-one'],
        ['mock', 'model-two'],
        ['biz', 'biz'],
        ['mock', 'model-one'],
      ])
    expect(modelOne.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    expect(assistantText(modelOne)).toBe('model one still ok')
    expect(modelTwo.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
  })

  it('does not reset another chain count when two chains share a provider', async () => {
    const adapter = new ScriptedAdapter({
      mock: [
        new LlmError('model two one', 'SERVER'),
        textResponse('model one ok'),
        new LlmError('model two two', 'SERVER'),
        new LlmError('model two three', 'SERVER'),
      ],
      biz: [textResponse('biz ok')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [
        chain({
          match: { provider: 'mock', model: 'model-one' },
          fallbacks: [{ provider: 'other', model: 'other' }],
        }),
        chain({
          match: { provider: 'mock', model: 'model-two' },
          fallbacks: [{ provider: 'biz', model: 'biz' }],
          failureThreshold: 2,
        }),
      ],
    }, { providers: ['mock', 'other', 'biz'] }))
    const modelOne = context.agentLoop.create(SessionId('fallback-shared-success-one'), {
      provider: 'mock',
      model: 'model-one',
    })
    const modelTwo = context.agentLoop.create(SessionId('fallback-shared-success-two'), {
      provider: 'mock',
      model: 'model-two',
    })

    await send(context, modelTwo, 'one')
    await send(context, modelOne, 'go')
    await send(context, modelTwo, 'two')

    // model-one's success on the shared provider must not clear model-two's
    // count: the second model-two failure reaches the threshold and switches.
    expect(adapter.requests.map(request => [request.provider, request.model]))
      .toEqual([
        ['mock', 'model-two'],
        ['mock', 'model-one'],
        ['mock', 'model-two'],
        ['biz', 'biz'],
      ])
    expect(assistantText(modelTwo)).toBe('biz ok')
    expect(modelTwo.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
  })

  it('never charges a chain for a failure of a request it did not route', async () => {
    const adapter = new ScriptedAdapter({
      mock: [textResponse('mock ok')],
      unrelated: [new LlmError('unrelated down', 'SERVER')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ match: { provider: 'mock', model: 'mock' } })],
    }, { providers: ['mock', 'other', 'unrelated'] }))
    const unrelated = context.agentLoop.create(SessionId('fallback-unrouted-failure'), {
      provider: 'unrelated',
      model: 'x',
    })

    await send(context, unrelated, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['unrelated'])
    expect(unrelated.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    expect(unrelated.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })
  })

  it('retries the head through llm-retry before the fallback switch', async () => {
    const adapter = new ScriptedAdapter({
      mock: [
        new LlmError('busy one', 'SERVER'),
        new LlmError('busy two', 'SERVER'),
        new LlmError('busy three', 'SERVER'),
      ],
      other: [textResponse('recovered')],
    })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }, {
      retryPolicies: {
        mock: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
        other: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
      },
    }))
    const agent = context.agentLoop.create(SessionId('fallback-retry-compose'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'mock', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => ({
      provider: event.data.provider,
      retry: event.data.retry,
    }))).toEqual([{ provider: 'mock', retry: 1 }])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(assistantText(agent)).toBe('recovered')
  })

  it('gives the fallback provider its own llm-retry budget', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('mock one', 'SERVER'), new LlmError('mock two', 'SERVER')],
      other: [new LlmError('other one', 'SERVER'), textResponse('recovered')],
    })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }, {
      retryPolicies: {
        mock: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
        other: normalConfig({ maxRetries: 1, retryableCodes: ['SERVER'] }),
      },
    }))
    const agent = context.agentLoop.create(SessionId('fallback-retry-budget'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider))
      .toEqual(['mock', 'mock', 'other', 'other'])
    expect(agent.session.events.filter(event => event.type === 'llm/retry').map(event => ({
      provider: event.data.provider,
      retry: event.data.retry,
    }))).toEqual([
      { provider: 'mock', retry: 1 },
      { provider: 'other', retry: 1 },
    ])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(assistantText(agent)).toBe('recovered')
  })

  it('drops the head-resolved reasoning effort but keeps sampling fields when switching entries', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('busy', 'SERVER')],
      other: [textResponse('switched without effort')],
    })
    adapter.configureReasoning(['mock'])
    const mounted = await harness(adapter, { chains: [chain()] })
    context = mounted.ctx
    // The effort-injecting listener mounts after the fallback plugin, so the
    // fallback's rewrite runs on the config the listener produced and the
    // strip reaches the final config (a listener mounted before fallback
    // would re-add the effort on the way out).
    mounted.ctx.on('agent/request', async (_payload, next) => ({
      ...await next(),
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.5,
      stop: ['stop-token'],
    }))
    const agent = mounted.ctx.agentLoop.create(SessionId('fallback-effort'), {
      provider: 'mock',
      model: 'mock',
      maxTokens: 128,
    })

    await send(mounted.ctx, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
    expect(adapter.requests[1]?.reasoningEffort).toBeUndefined()
    expect(adapter.requests[1]).toMatchObject({
      maxTokens: 128,
      temperature: 0.5,
      stop: ['stop-token'],
    })
    expect(assistantText(agent)).toBe('switched without effort')
  })

  it('lets turn cancellation win before a switch during request routing', async () => {
    const adapter = new ScriptedAdapter({ mock: [textResponse('must not run')] })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }, {
      beforeMount: (ctx) => {
        ctx.on('agent/request', async ({ agent }, next) => {
          agent.cancel({ kind: 'user' })
          return next()
        })
      },
    }))
    const agent = context.agentLoop.create(SessionId('fallback-route-cancel'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.events.some(event => event.type === 'llm/fallback-route')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('lets turn cancellation win before a switch', async () => {
    const adapter = new ScriptedAdapter({ mock: [new LlmError('busy', 'SERVER')] })
    ;({ ctx: context } = await harness(adapter, { chains: [chain()] }, {
      beforeMount: (ctx) => {
        ctx.on('agent/request-error', async ({ agent }, next) => {
          agent.cancel({ kind: 'user' })
          return next()
        })
      },
    }))
    const agent = context.agentLoop.create(SessionId('fallback-cancel'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock'])
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
  })

  it('fails over a missing head adapter when NO_ADAPTER is switchable', async () => {
    const adapter = new ScriptedAdapter({ other: [textResponse('served by other')] })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ switchCodes: ['SERVER', 'NO_ADAPTER'] })],
    }, { providers: ['other'] }))
    const agent = context.agentLoop.create(SessionId('fallback-no-adapter'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['other'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'llm/fallback')).toMatchObject({
      data: { failure: { code: 'NO_ADAPTER' } },
    })
    expect(assistantText(agent)).toBe('served by other')
  })

  it('stops switching after plugin disposal', async () => {
    const adapter = new ScriptedAdapter({ mock: [new LlmError('busy', 'SERVER')] })
    const mounted = await harness(adapter, { chains: [chain()] })
    context = mounted.ctx
    await mounted.fallbackFiber.dispose()
    const agent = context.agentLoop.create(SessionId('fallback-disposed'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock'])
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })
  })

  it('uses the default chain for requests no match condition covers', async () => {
    const adapter = new ScriptedAdapter({
      mock: [
        new LlmError('model one down', 'SERVER'),
        new LlmError('model two down', 'SERVER'),
      ],
      other: [textResponse('fallback one'), textResponse('fallback two')],
      biz: [textResponse('fallback two')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [
        chain({ match: { provider: 'mock', model: 'model-one' } }),
        chain({ fallbacks: [{ provider: 'biz', model: 'biz' }] }),
      ],
    }, { providers: ['mock', 'other', 'biz'] }))
    const modelOne = context.agentLoop.create(SessionId('fallback-default-match'), {
      provider: 'mock',
      model: 'model-one',
    })
    const modelTwo = context.agentLoop.create(SessionId('fallback-default-unmatched'), {
      provider: 'mock',
      model: 'model-two',
    })

    await send(context, modelOne, 'go')
    expect(assistantText(modelOne)).toBe('fallback one')
    await send(context, modelTwo, 'go')
    expect(assistantText(modelTwo)).toBe('fallback two')

    expect(adapter.requests.map(request => request.provider))
      .toEqual(['mock', 'other', 'mock', 'biz'])
    const defaultSwitch = modelTwo.session.events.find(event => event.type === 'llm/fallback')
    expect(defaultSwitch).toMatchObject({ data: { headProvider: 'mock', toProvider: 'biz' } })
  })

  it('passes through requests that match no chain when no default chain exists', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('down', 'SERVER')],
      other: [textResponse('must not run')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({ match: { provider: 'mock', model: 'mock' } })],
    }, { providers: ['mock', 'other'] }))
    const agent = context.agentLoop.create(SessionId('fallback-unmatched-passthrough'), {
      provider: 'mock',
      model: 'model-other',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock'])
    expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })
  })

  it('advances through every fallback and stops at the last one', async () => {
    const adapter = new ScriptedAdapter({
      mock: [new LlmError('mock down', 'SERVER')],
      other: [new LlmError('other down', 'SERVER')],
      biz: [new LlmError('biz down', 'SERVER')],
    })
    ;({ ctx: context } = await harness(adapter, {
      chains: [chain({
        fallbacks: [
          { provider: 'other', model: 'other' },
          { provider: 'biz', model: 'biz' },
        ],
      })],
    }, { providers: ['mock', 'other', 'biz'] }))
    const agent = context.agentLoop.create(SessionId('fallback-multi'), {
      provider: 'mock',
      model: 'mock',
    })

    await send(context, agent, 'go')

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'biz'])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')
      .map(event => event.data.toProvider))
      .toEqual(['other', 'biz'])
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'SERVER' } } },
    })
  })

  const invalidConfigs: readonly [string, unknown, RegExp][] = [
    ['deprecated providers key', {
      chains: [{
        providers: [
          { provider: 'mock', model: 'mock' },
          { provider: 'other', model: 'other' },
        ],
      }],
    }, /providers is deprecated/],
    ['empty fallbacks', {
      chains: [{
        fallbacks: [],
      }],
    }, /fallbacks must list at least one/],
    ['missing fallbacks', {
      chains: [{}],
    }, /fallbacks must list at least one/],
    ['duplicate fallback entries', {
      chains: [{
        fallbacks: [
          { provider: 'mock', model: 'mock' },
          { provider: 'mock', model: 'mock' },
        ],
      }],
    }, /must not repeat provider\/model entries/],
    ['shared fallback entries', {
      chains: [
        { match: { provider: 'a', model: 'a' }, fallbacks: [{ provider: 'mock', model: 'mock' }] },
        { match: { provider: 'b', model: 'b' }, fallbacks: [{ provider: 'mock', model: 'mock' }] },
      ],
    }, /must not share fallback entries/],
    ['two default chains', {
      chains: [
        { fallbacks: [{ provider: 'mock', model: 'mock' }] },
        { fallbacks: [{ provider: 'other', model: 'other' }] },
      ],
    }, /at most one default chain/],
    ['match without provider', {
      chains: [{
        match: {},
        fallbacks: [{ provider: 'mock', model: 'mock' }],
      }],
    }, /match\.provider must be a non-empty string/],
    ['empty switch codes', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock' }],
        switchCodes: [],
      }],
    }, /switchCodes must not be empty/],
    ['duplicate switch codes', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock' }],
        switchCodes: ['SERVER', 'SERVER'],
      }],
    }, /switchCodes must not contain duplicates/],
    ['non-string switch code', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock' }],
        switchCodes: ['SERVER', 42],
      }],
    }, /switchCodes must contain only non-empty strings/],
    ['zero threshold', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock' }],
        failureThreshold: 0,
      }],
    }, /positive safe integer/],
    ['fractional threshold', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock' }],
        failureThreshold: 1.5,
      }],
    }, /positive safe integer/],
    ['negative cooldown', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock' }],
        cooldownMs: -1,
      }],
    }, /cooldownMs must be a finite number/],
    ['overflow cooldown', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock' }],
        cooldownMs: MAX_TIMER_DELAY_MS + 1,
      }],
    }, /cooldownMs must be a finite number/],
    ['unknown chain key', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock' }],
        retryPolicy: {},
      }],
    }, /unknown key "retryPolicy"/],
    ['unknown provider key', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: 'mock', extra: true }],
      }],
    }, /unknown key "extra"/],
    ['empty provider', {
      chains: [{
        fallbacks: [{ provider: '', model: 'mock' }],
      }],
    }, /provider must be a non-empty string/],
    ['empty model', {
      chains: [{
        fallbacks: [{ provider: 'mock', model: '' }],
      }],
    }, /model must be a non-empty string/],
  ]
  for (const [_name, config, message] of invalidConfigs) {
    expect(() => {
      fallback.apply(new Context(), config as fallback.Config)
    }).toThrow(message)
  }
})
