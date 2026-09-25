import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// 0.1.7 splits the DeepSeek adapter library from the provider plugin that
// registers the route: the api-key plugin owns `deepseek-official`.
import * as LlmDeepSeekApiKey from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { MockLlmServer, MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as fallback from '../src/index.ts'
import { startMessagesServer } from './support/messages-server.ts'
import type { FixtureMessagesServer } from './support/messages-server.ts'

let context: Context | undefined
const servers: MockLlmServer[] = []
const fixtures: FixtureMessagesServer[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(fixtures.splice(0).map(server => server.close()))
})

async function start(
  sequence: MockLlmServerOptions['sequence'],
  options: Omit<MockLlmServerOptions, 'sequence'> = {},
): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence, ...options })
  servers.push(server)
  return server
}

/** Start the named-SSE Messages fixture that stands in for the pi-ai route. */
async function startFixture(text: string): Promise<FixtureMessagesServer> {
  const server = await startMessagesServer({ text, apiKey: 'mock-key' })
  fixtures.push(server)
  return server
}

async function harness(
  primaryBaseURL: string,
  fallbackBaseURL: string,
  chain: fallback.Options = {
    fallbacks: [{ provider: 'pi-mock', model: 'mock-model' }],
  },
): Promise<Context> {
  vi.stubEnv('DEEPSEEK_API_KEY', 'mock-key')
  vi.stubEnv('PI_MOCK_KEY', 'mock-key')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LlmDeepSeekApiKey, {
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
        api: 'anthropic-messages',
        baseURL: fallbackBaseURL,
        models: [{ id: 'mock-model', name: 'Mock Model' }],
      },
    },
  })
  // The Loader resolves the entry's Config schema; tests build the same live
  // references through the shipped schema.
  const live = fallback.Config(chain)
  await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, live)
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
    const fallbackServer = await startFixture('served by the fallback provider')
    context = await harness(primary.baseURL, fallbackServer.baseURL)
    const agent = await context.agentLoop.create(SessionId('wire-fallback'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await send(context, agent)

    expect(primary.requests).toHaveLength(1)
    expect(fallbackServer.requests).toHaveLength(1)
    // The same conversation reaches both providers; adapter-owned wire
    // extensions (max tokens, thinking, Anthropic cache_control) legitimately
    // differ between the two protocols.
    const conversation = (body: unknown): Array<{ role: string; text: string }> =>
      ((body as { messages?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }> })
        .messages ?? []).map(message => ({
        role: message.role ?? '',
        text: (message.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(''),
      }))
    expect(conversation(fallbackServer.requests[0]?.body)).toEqual(conversation(primary.requests[0]?.body))
    const switchEvent = agent.session.snapshotEvents().find(event => event.type === 'llm/fallback')
    expect(switchEvent).toMatchObject({
      data: {
        fromProvider: 'deepseek-official',
        toProvider: 'pi-mock',
        failure: { code: 'SERVER' },
      },
    })
    const routeEvent = agent.session.snapshotEvents().find(event => event.type === 'llm/fallback-route')
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
    const fallbackServer = await startFixture('fallback text')
    context = await harness(primary.baseURL, fallbackServer.baseURL, {
      fallbacks: [{ provider: 'pi-mock', model: 'mock-model' }],
      cooldownMs: 60_000,
    })
    const agent = await context.agentLoop.create(SessionId('wire-fallback-cooldown'), {
      provider: 'deepseek-official',
      model: 'mock-model',
    })

    await send(context, agent)
    await send(context, agent)

    expect(primary.requests).toHaveLength(2)
    expect(fallbackServer.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/fallback-route')
      .map(event => event.data.turn))
      .toEqual([1, 2])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/fallback')).toHaveLength(2)
    expect(finalAssistantText(agent)).toBe('fallback text')
  })
})
