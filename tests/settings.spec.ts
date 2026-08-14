/**
 * Settings-seam integration and config-bridge tests: the plugin registers the
 * `llm-fallback` namespace, a committed settings write rebuilds the circuits
 * hot (next request uses the new chain), invalid writes are refused at the
 * seam, and the loopback config bridge serves GET/PUT/DELETE with the
 * revision fence and the loopback/cross-site guard.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as fallback from '../src/index.ts'
import { FALLBACK_SETTINGS_NAMESPACE } from '../src/index.ts'
import { handleConfigBridge } from '../src/config-http.ts'

/** In-memory settings provider fixture (smallest real SettingsProvider subclass). */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: string[] = []
  private readonly scripts: Map<string, () => StreamChunk[] | Error>

  constructor(scripts: Record<string, () => StreamChunk[] | Error>) {
    super()
    this.scripts = new Map(Object.entries(scripts))
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options.provider)
    const script = this.scripts.get(options.provider)
    if (script === undefined) throw new Error(`no script for provider "${options.provider}"`)
    const entry = script()
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

function chainConfig(
  pairs: Array<[string, string]>,
): fallback.Config {
  return {
    fallbacks: pairs.map(([provider, model]) => ({ provider, model })),
    switchCodes: ['SERVER'],
    failureThreshold: 1,
    cooldownMs: 0,
  }
}

function fullSection(
  pairs: Array<[string, string]>,
): { fallbacks: Array<{ provider: string; model: string }>; switchCodes: string[]; failureThreshold: number; cooldownMs: number } {
  return {
    fallbacks: pairs.map(([provider, model]) => ({ provider, model })),
    switchCodes: ['SERVER'],
    failureThreshold: 1,
    cooldownMs: 0,
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function harness(config: fallback.Config): Promise<{ ctx: Context; provider: MemorySettings }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, config)
  }, { inject: fallback.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  return { ctx, provider: ctx.get('settings') as MemorySettings }
}

async function send(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = agent.whenIdle()
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

/** Let queued settings watchers (and the hot rebuild) settle before the next request. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('settings seam integration', () => {
  it('registers the llm-fallback namespace with the entry as its base layer', async () => {
    const config = chainConfig([['mock', 'mock'], ['other', 'other']])
    ;({ ctx: context } = await harness(config))

    const descriptor = context.settings.describe({ redactSecrets: true })
      .find(candidate => candidate.ns === FALLBACK_SETTINGS_NAMESPACE)
    expect(descriptor).toBeDefined()
    expect(descriptor?.base).toMatchObject(config)
    expect(descriptor?.value).toMatchObject(config)
    expect(descriptor?.user).toBeUndefined()
    expect(descriptor?.revision).toBe(0)
  })

  it('rebuilds the circuits hot when the saved section replaces the chains', async () => {
    const adapter = new ScriptedAdapter({
      mock: () => new LlmError('primary outage', 'SERVER'),
      other: () => textResponse('recovered'),
      alt1: () => new LlmError('alt outage', 'SERVER'),
      alt2: () => textResponse('alt fallback'),
    })
    const { ctx } = await harness(chainConfig([['other', 'other']]))
    const dispose = ctx.llm.registerAdapter(['mock', 'other', 'alt1', 'alt2'], adapter)
    try {
      const agent = ctx.agentLoop.create(SessionId('settings-hot'), {
        provider: 'mock',
        model: 'mock',
      })
      await send(ctx, agent, 'first')
      expect(adapter.requests).toEqual(['mock', 'other'])

      await ctx.settings.replace(FALLBACK_SETTINGS_NAMESPACE, fullSection([['alt2', 'alt2']]))
      await settle()

      const next = ctx.agentLoop.create(SessionId('settings-hot-2'), {
        provider: 'alt1',
        model: 'alt1',
      })
      await send(ctx, next, 'second')

      // The new chain routes alt1 -> alt2 on a SERVER failure: the request
      // reached alt1 and switched to alt2, proving the rebuild took effect.
      expect(adapter.requests).toEqual(['mock', 'other', 'alt1', 'alt2'])
      expect(next.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
      expect(next.session.events.find(event => event.type === 'llm/fallback-route')).toMatchObject({
        data: { provider: 'alt2', model: 'alt2' },
      })
    } finally {
      dispose()
    }
  })

  it('starts dormant and routes after a settings write adds the first chain', async () => {
    const adapter = new ScriptedAdapter({
      mock: () => new LlmError('busy', 'SERVER'),
      other: () => textResponse('recovered'),
    })
    const { ctx } = await harness({})
    const dispose = ctx.llm.registerAdapter(['mock', 'other'], adapter)
    try {
      const agent = ctx.agentLoop.create(SessionId('settings-empty-to-chain'), {
        provider: 'mock',
        model: 'mock',
      })
      await send(ctx, agent, 'first')
      // Dormant: the failing provider surfaces normally, nothing routes.
      expect(adapter.requests).toEqual(['mock'])
      expect(agent.session.events.some(event => event.type === 'llm/fallback')).toBe(false)

      await ctx.settings.replace(FALLBACK_SETTINGS_NAMESPACE, fullSection([['other', 'other']]))
      await settle()

      const next = ctx.agentLoop.create(SessionId('settings-empty-to-chain-2'), {
        provider: 'mock',
        model: 'mock',
      })
      await send(ctx, next, 'second')
      // Dormant turn first, then the new fallback list routes mock -> other.
      expect(adapter.requests).toEqual(['mock', 'mock', 'other'])
      expect(next.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(1)
      expect(next.session.events.find(event => event.type === 'llm/fallback-route')).toMatchObject({
        data: { provider: 'other', model: 'other' },
      })
    } finally {
      dispose()
    }
  })

  it('refuses a saved section that violates cross-field constraints', async () => {
    ;({ ctx: context } = await harness(chainConfig([['other', 'other']])))

    // Empty fallbacks fail the owner validate hook.
    const emptyFallbacks = { fallbacks: [], switchCodes: ['SERVER'], failureThreshold: 1, cooldownMs: 0 }
    await expect(context.settings.replace(FALLBACK_SETTINGS_NAMESPACE, emptyFallbacks))
      .rejects.toThrow(/fallbacks must list at least one/)

    // Duplicate fallback entries fail the owner validate hook.
    const duplicates = {
      fallbacks: [
        { provider: 'a', model: 'a' },
        { provider: 'a', model: 'a' },
      ],
      switchCodes: ['SERVER'], failureThreshold: 1, cooldownMs: 0,
    }
    await expect(context.settings.replace(FALLBACK_SETTINGS_NAMESPACE, duplicates))
      .rejects.toThrow(/must not repeat provider\/model entries/)

    // The deprecated chains key fails the owner validate hook.
    const deprecated = {
      chains: [{ fallbacks: [{ provider: 'a', model: 'a' }] }],
    }
    await expect(context.settings.replace(FALLBACK_SETTINGS_NAMESPACE, deprecated))
      .rejects.toThrow(/is deprecated/)
  })
})

/** Build a minimal node:http request stub (async-iterable body for PUT). */
function stubRequest(options: {
  method: string
  remoteAddress?: string
  headers?: Record<string, string>
  body?: unknown
}): IncomingMessage {
  const request = {
    method: options.method,
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () {
      if (options.body !== undefined) {
        yield Buffer.from(JSON.stringify(options.body))
      }
    },
  }
  return request as unknown as IncomingMessage
}

/** Build a minimal server-response stub capturing status and body. */
function stubResponse(): { status: number; body: string } & ServerResponse {
  const out = { status: 0, body: '' } as { status: number; body: string } & {
    writeHead?: (status: number, headers?: unknown) => void
    end?: (body?: string) => void
  }
  out.writeHead = (status: number) => { out.status = status }
  out.end = (body?: string) => { out.body = body ?? '' }
  return out as unknown as { status: number; body: string } & ServerResponse
}

async function bootBridge(options?: ConstructorParameters<typeof MemorySettings>[1]): Promise<{
  ctx: Context
  provider: MemorySettings
}> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, options)
  const provider = ctx.get('settings') as MemorySettings
  provider.register(FALLBACK_SETTINGS_NAMESPACE, fallback.Config, {
    base: chainConfig([['mock', 'mock'], ['other', 'other']]),
    // Same cross-field gate the plugin applies through installSettingsSection.
    validate: (value) => { fallback.resolveConfig(value) },
  })
  return { ctx, provider }
}

describe('config bridge', () => {
  it('keeps the base fallbacks when the section omits them', async () => {
    const { ctx } = await bootBridge()
    const res = stubResponse()
    await handleConfigBridge(ctx, stubRequest({
      method: 'PUT',
      body: { expectedRevision: 0, section: {} },
    }), res)

    expect(res.status).toBe(200)
    const view = JSON.parse(res.body) as { value: { fallbacks: Array<{ provider: string }> }; revision: number }
    expect(view.value.fallbacks.map(entry => entry.provider)).toEqual(['mock', 'other'])
    expect(view.revision).toBe(0)
  })

  it('serves the resolved view over GET', async () => {
    const { ctx } = await bootBridge()
    const res = stubResponse()
    await handleConfigBridge(ctx, stubRequest({ method: 'GET' }), res)

    expect(res.status).toBe(200)
    const view = JSON.parse(res.body) as { available: boolean; value: { fallbacks: unknown[] }; revision: number }
    expect(view.available).toBe(true)
    expect(view.value.fallbacks).toHaveLength(2)
    expect(view.revision).toBe(0)
  })

  it('persists a PUT and reflects it on the next GET', async () => {
    const { ctx, provider } = await bootBridge()
    const res = stubResponse()
    await handleConfigBridge(ctx, stubRequest({
      method: 'PUT',
      body: { expectedRevision: 0, section: fullSection([['a', 'a'], ['b', 'b']]) },
    }), res)

    expect(res.status).toBe(200)
    const saved = JSON.parse(res.body) as { value: { fallbacks: unknown[] }; revision: number }
    expect(saved.value.fallbacks).toHaveLength(2)
    expect(saved.revision).toBe(1)
    expect(provider.doc[String(FALLBACK_SETTINGS_NAMESPACE)]).toMatchObject(
      fullSection([['a', 'a'], ['b', 'b']]),
    )

    const get = stubResponse()
    await handleConfigBridge(ctx, stubRequest({ method: 'GET' }), get)
    const view = JSON.parse(get.body) as { user: unknown; value: { fallbacks: Array<{ provider: string }> } }
    expect(view.user).toBeDefined()
    expect(view.value.fallbacks.map(entry => entry.provider)).toEqual(['a', 'b'])
  })

  it('clears the saved section on DELETE, returning to the base', async () => {
    const { ctx, provider } = await bootBridge()
    await handleConfigBridge(ctx, stubRequest({
      method: 'PUT',
      body: { expectedRevision: 0, section: fullSection([['a', 'a'], ['b', 'b']]) },
    }), stubResponse())

    const res = stubResponse()
    await handleConfigBridge(ctx, stubRequest({ method: 'DELETE' }), res)
    expect(res.status).toBe(200)
    const view = JSON.parse(res.body) as { user?: unknown; value: { fallbacks: Array<{ provider: string }> } }
    expect(view.user).toBeUndefined()
    expect(view.value.fallbacks.map(entry => entry.provider)).toEqual(['mock', 'other'])
    // The memory fixture persists the empty section; the file provider drops the node.
  })

  it('refuses a stale write with 409 settings-conflict', async () => {
    const { ctx } = await bootBridge()
    await handleConfigBridge(ctx, stubRequest({
      method: 'PUT',
      body: { expectedRevision: 0, section: fullSection([['a', 'a'], ['b', 'b']]) },
    }), stubResponse())

    const res = stubResponse()
    await handleConfigBridge(ctx, stubRequest({
      method: 'PUT',
      body: { expectedRevision: 0, section: fullSection([['c', 'c'], ['d', 'd']]) },
    }), res)

    expect(res.status).toBe(409)
    const body = JSON.parse(res.body) as { error: { code: string } }
    expect(body.error.code).toBe('settings-conflict')
  })

  it('rejects an invalid section with 400 settings-rejected', async () => {
    const { ctx } = await bootBridge()
    const res = stubResponse()
    await handleConfigBridge(ctx, stubRequest({
      method: 'PUT',
      body: { expectedRevision: 0, section: { fallbacks: [] } },
    }), res)

    expect(res.status).toBe(400)
    const body = JSON.parse(res.body) as { error: { code: string } }
    expect(body.error.code).toBe('settings-rejected')
  })

  it('answers available:false when no settings provider is mounted', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const res = stubResponse()
    await handleConfigBridge(ctx, stubRequest({ method: 'GET' }), res)

    expect(res.status).toBe(200)
    const view = JSON.parse(res.body) as { available: boolean }
    expect(view.available).toBe(false)
  })

  it('guards against non-loopback peers, cross-site markers, and origin mismatch', async () => {
    const { ctx } = await bootBridge()

    const lan = stubResponse()
    await handleConfigBridge(ctx, stubRequest({ method: 'GET', remoteAddress: '192.168.1.20' }), lan)
    expect(lan.status).toBe(403)

    const crossSite = stubResponse()
    await handleConfigBridge(ctx, stubRequest({
      method: 'GET',
      headers: { 'sec-fetch-site': 'cross-site' },
    }), crossSite)
    expect(crossSite.status).toBe(403)

    const mismatched = stubResponse()
    await handleConfigBridge(ctx, stubRequest({
      method: 'GET',
      headers: { origin: 'http://evil.example', host: '127.0.0.1:3080' },
    }), mismatched)
    expect(mismatched.status).toBe(403)

    const trusted = stubResponse()
    await handleConfigBridge(ctx, stubRequest({
      method: 'GET',
      headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
    }), trusted)
    expect(trusted.status).toBe(200)
  })
})
