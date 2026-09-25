import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import * as fallback from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

/** Cordis fiber states (`FiberState` is a const enum, so the values are pinned here). */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

class FailoverAdapter extends LlmAdapter {
  readonly requests: string[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options.provider)
    if (options.provider === 'mock') {
      throw new LlmError('primary outage', 'SERVER')
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'fallback recovered' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fallback recovered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-fallback-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session-projection', SessionProjection],
    ['@deepseek-ai/dsh-llm-retry', retry],
    ['@deepseek-ai/dsh-llm-fallback', fallback],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('loads fallback chains and fails the same request over to the next provider', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    fallbacks:',
      '      - provider: other',
      '        model: other',
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)

    const adapter = new FailoverAdapter()
    loaded.llm.registerAdapter(['mock', 'other'], adapter)
    const agent = await loaded.agentLoop.create(SessionId('loader-fallback'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // dsh-llm-retry 0.1.5: a provider with no retryPolicy delegates immediately,
    // so the initial attempt reaches the fallback without same-provider retries.
    expect(adapter.requests).toEqual(['mock', 'other'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/fallback')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'llm/fallback-route')).toMatchObject({
      data: { provider: 'other', model: 'other' },
    })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'fallback recovered' }],
      source: { kind: 'model', provider: 'other', model: 'other' },
    })
  })

  it('rejects an empty fallback list at load time', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    fallbacks: []',
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])
    // The schema rejects the entry, so the Loader marks its fiber failed
    // instead of activating a plugin with no usable fallback list.
    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === '@deepseek-ai/dsh-llm-fallback')
    expect(entry?.fiber?.state).toBe(FIBER_FAILED)
  })

  it('rebuilds the circuit hot when a committed volatile config update lands', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-llm-fallback'",
      '  config:',
      '    fallbacks:',
      '      - provider: other',
      '        model: other',
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])

    const adapter = new FailoverAdapter()
    loaded.llm.registerAdapter(['mock', 'other', 'alt2'], adapter)
    const entry = [...loaded.loader.entries()]
      .find(candidate => candidate.options.name === '@deepseek-ai/dsh-llm-fallback')
    expect(entry?.fiber?.state).toBe(FIBER_ACTIVE)

    const agent = await loaded.agentLoop.create(SessionId('loader-volatile'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests).toEqual(['mock', 'other'])

    // A committed settings write is a volatile-only config update: the Loader
    // rewrites the running references and notifies the owning fiber, which is
    // what rebuilds the circuit without a remount.
    await entry!.update({ config: { fallbacks: [{ provider: 'alt2', model: 'alt2' }] } })

    const next = await loaded.agentLoop.create(SessionId('loader-volatile-2'), {
      provider: 'mock',
      model: 'mock',
    })
    next.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await next.whenIdle()

    expect(adapter.requests).toEqual(['mock', 'other', 'mock', 'alt2'])
    expect(next.session.snapshotEvents().find(event => event.type === 'llm/fallback-route')).toMatchObject({
      data: { provider: 'alt2', model: 'alt2' },
    })
  })
})
