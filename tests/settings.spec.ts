/**
 * Settings-seam tests: every Config field is projected as a live reference
 * (which is what makes this profile entry configurable from the harness UI),
 * plain values are read through `plainOptions`, and the plugin suppresses the
 * harness-generated page for its own entry because it ships its own editor.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as fallback from '../src/index.ts'
import { DEFAULT_SWITCH_CODES, FALLBACK_SETTINGS_NAMESPACE, plainOptions } from '../src/index.ts'

/** Minimal settings service stand-in: records every presentation registration. */
class RecordingSettings extends Service {
  readonly configured: Array<{ presentation: { auto?: boolean }; owner: unknown }> = []

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  configure(presentation: { auto?: boolean }, owner?: unknown): () => void {
    this.configured.push({ presentation, owner })
    return () => {}
  }
}

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Mount the plugin against a recording settings service. */
async function mount(
  raw: fallback.Options,
): Promise<{ ctx: Context; settings: RecordingSettings; fiber: unknown }> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(RecordingSettings)
  const settings = ctx.get('settings') as unknown as RecordingSettings
  let fiber: unknown
  await ctx.plugin(Object.assign((inner: Context) => {
    fiber = inner.fiber
    fallback.apply(inner, fallback.Config(raw))
  }, { inject: fallback.inject }))
  // The settings presentation rides `ctx.inject`, which lands a tick later.
  await new Promise(resolve => setTimeout(resolve, 0))
  context = ctx
  return { ctx, settings, fiber }
}

describe('Config projection', () => {
  it('projects every field as a live reference (the settings form only serves volatile fields)', () => {
    const dict = (fallback.Config as unknown as {
      dict: Record<string, { meta?: { volatile?: boolean } }>
    }).dict
    expect(Object.keys(dict)).toEqual(['fallbacks', 'switchCodes', 'failureThreshold', 'cooldownMs'])
    for (const [field, schema] of Object.entries(dict)) {
      expect(schema.meta?.volatile, `${field} must stay volatile to remain configurable`).toBe(true)
    }
  })

  it('reads the current plain values behind the references', () => {
    const config = fallback.Config({ fallbacks: [{ provider: 'other', model: 'other' }] })
    expect(typeof config.fallbacks.get).toBe('function')
    expect(plainOptions(config)).toEqual({
      fallbacks: [{ provider: 'other', model: 'other' }],
      switchCodes: [...DEFAULT_SWITCH_CODES],
      failureThreshold: 1,
      cooldownMs: 0,
    })
  })

  it('keeps an absent fallback list absent, so the plugin mounts dormant', () => {
    const config = fallback.Config({})
    expect(config.fallbacks.get()).toBeUndefined()
    expect(plainOptions(config)).toEqual({
      switchCodes: [...DEFAULT_SWITCH_CODES],
      failureThreshold: 1,
      cooldownMs: 0,
    })
    expect(fallback.resolveConfig(plainOptions(config))).toBeUndefined()
  })

  it('resolves live values committed after mount', () => {
    const config = fallback.Config({ fallbacks: [{ provider: 'other', model: 'other' }] })
    // A committed volatile update rewrites the value behind the same reference.
    const write: symbol = Symbol.for('cosmokit.volatile.write')
    const ref = config.fallbacks as unknown as Record<symbol, (value: unknown) => void>
    ref[write]!([{ provider: 'alt', model: 'alt' }])
    expect(plainOptions(config).fallbacks).toEqual([{ provider: 'alt', model: 'alt' }])
  })

  it('exposes the profile entry id the browser half edits', () => {
    expect(FALLBACK_SETTINGS_NAMESPACE).toBe('llm-fallback')
  })
})

describe('settings presentation', () => {
  it('suppresses the generated page and owns the configuration surface', async () => {
    const { settings, fiber } = await mount({ fallbacks: [{ provider: 'other', model: 'other' }] })
    expect(settings.configured).toEqual([{ presentation: { auto: false }, owner: fiber }])
  })

  it('mounts dormant without a settings service', async () => {
    const ctx = new Context()
    context = ctx
    await expect(ctx.plugin(Object.assign((inner: Context) => {
      fallback.apply(inner, fallback.Config({}))
    }, { inject: fallback.inject }))).resolves.toBeDefined()
  })
})
