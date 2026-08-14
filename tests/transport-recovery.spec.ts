import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { MockLlmServer, MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as fallback from '../src/index.ts'

let context: Context | undefined
const servers: MockLlmServer[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(servers.splice(0).map(server => server.close()))
})

async function start(
  sequence: MockLlmServerOptions['sequence'],
  options: Omit<MockLlmServerOptions, 'sequence'> = {},
): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence, ...options })
  servers.push(server)
  return server
}

async function harness(
  primaryBaseURL: string,
  fallbackBaseURL: string,
  chain: Parameters<typeof fallback.apply>[1] = {
    chains: [{
      match: { provider: 'deepseek-official', model: 'mock-model' },
      fallbacks: [{ provider: 'pi-mock', model: 'mock-model' }],
    }],
  },
): Promise<Context> {
  vi.stubEnv('DEEPSEEK_API_KEY', 'mock-key')
  vi.stubEnv('PI_MOCK_KEY', 'mock-key')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LlmDeepSeek, {
    baseURL: primaryBaseURL,
    streamIdleTimeoutMs: 1_000,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 0,
      backoff: { initialDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
    },
  })
  await ctx.plugin(LlmPiAi, {
    providers: {
      'pi-mock': {
        apiKeyEnv: 'PI_MOCK_KEY',
        api: 'openai-completions',
        baseURL: fallbackBaseURL,
        models: [{ id: 'mock-model', name: 'Mock Model' }],
      },
    },
  })
  await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, chain)
  }, { inject: fallback.inject }))
  // Re-assert the user's head on every request, mirroring the harness
  // model-selection listener the web UI installs (the head is the request).
  ctx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    return { ...resolved, provider: 'deepseek-official', model: 'mock-model' }
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function send(ctx: Context, agent: Agent): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'recover across providers' }],
    source: { kind: 'user' },
  }))
  return idle
}

function finalAssistantText(agent: Agent): string | undefined {
  const message = agent.session.deriveMessages().at(-1)
  if (message?.role !== 'assistant') return undefined
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('provider fallback through real adapters', () => {
  it('serves the request from the second provider after the first returns HTTP 500', async () => {
    const primary = await start(['server_error'], { apiKey: 'mock-key' })
    const fallbackServer = await start(['success'], {
      apiKey: 'mock-key',
      successText: 'served by the fallback provider',
    })
    context = await harness(primary.baseURL, fallbackServer.baseURL)
    const agent = context.agentLoop.create(SessionId('wire-fallback'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await send(context, agent)

    expect(primary.requests).toHaveLength(1)
    expect(fallbackServer.requests).toHaveLength(1)
    // The conversation reaches both providers verbatim; adapter-owned wire
    // knobs (max tokens, thinking) legitimately differ between providers.
    const primaryBody = primary.requests[0]?.body as { messages?: unknown } | undefined
    const fallbackBody = fallbackServer.requests[0]?.body as { messages?: unknown } | undefined
    expect(fallbackBody?.messages).toEqual(primaryBody?.messages)
    const switchEvent = agent.session.events.find(event => event.type === 'llm/fallback')
    expect(switchEvent).toMatchObject({
      data: {
        fromProvider: 'deepseek-official',
        toProvider: 'pi-mock',
        failure: { code: 'SERVER' },
      },
    })
    const routeEvent = agent.session.events.find(event => event.type === 'llm/fallback-route')
    expect(routeEvent).toMatchObject({
      data: { provider: 'pi-mock', model: 'mock-model' },
    })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { kind: 'model', provider: 'pi-mock', model: 'mock-model' },
    })
    expect(finalAssistantText(agent)).toBe('served by the fallback provider')
  })

  it('stays on the fallback provider for later requests during the head cooldown', async () => {
    const primary = await start(['server_error', 'server_error'], { apiKey: 'mock-key' })
    const fallbackServer = await start(['success', 'success'], {
      apiKey: 'mock-key',
      successText: 'fallback text',
    })
    context = await harness(primary.baseURL, fallbackServer.baseURL, {
      chains: [{
        match: { provider: 'deepseek-official', model: 'mock-model' },
        fallbacks: [{ provider: 'pi-mock', model: 'mock-model' }],
        cooldownMs: 60_000,
      }],
    })
    const agent = context.agentLoop.create(SessionId('wire-fallback-cooldown'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await send(context, agent)
    await send(context, agent)

    expect(primary.requests).toHaveLength(2)
    expect(fallbackServer.requests).toHaveLength(2)
    expect(agent.session.events.filter(event => event.type === 'llm/fallback-route')
      .map(event => event.data.turn))
      .toEqual([1, 2])
    expect(agent.session.events.filter(event => event.type === 'llm/fallback')).toHaveLength(2)
    expect(finalAssistantText(agent)).toBe('fallback text')
  })
})
