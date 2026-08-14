import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as FallbackInvariant from '../src/invariant.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(FallbackInvariant)
  return ctx
}

function openStep(ctx: Context, id: string, turn = 1, step = 1): Session {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  return session
}

const failure = { message: 'provider busy', code: 'RATE_LIMIT', status: 429 }
const switchData = {
  turn: 1,
  step: 1,
  headProvider: 'mock',
  headModel: 'mock',
  fromProvider: 'mock',
  fromModel: 'mock',
  toProvider: 'other',
  toModel: 'other',
  reason: 'threshold' as const,
  failure,
  cooldownMs: 0,
}
const routeData = {
  turn: 1,
  step: 1,
  headProvider: 'mock',
  headModel: 'mock',
  provider: 'other',
  model: 'other',
}

describe('llm-fallback invariants', () => {
  it('accepts switch and route records inside their open steps', async () => {
    const ctx = await setup()
    const session = openStep(ctx, 'fallback-invariant-valid')

    expect(() => {
      session.append('llm/fallback', switchData)
      session.append('llm/fallback', { ...switchData, reason: 'probe' })
      session.append('llm/fallback-route', routeData)
      session.append('llm/fallback-route', {
        ...routeData, turn: 1, step: 1, provider: 'baz', model: 'baz',
      })
    }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('validates the complete durable failure payload', async () => {
    const ctx = await setup()
    const complete = openStep(ctx, 'fallback-invariant-complete-failure')
    expect(() => {
      complete.append('llm/fallback', {
        ...switchData,
        failure: {
          message: 'provider busy',
          code: 'RATE_LIMIT',
          status: 429,
          providerRetryAfterMs: 25,
          requestId: ProviderRequestId('request-1'),
        },
      })
    }).not.toThrow()

    const invalidFailures: readonly [string, unknown, RegExp][] = [
      ['null', null, /failure must be an object/],
      ['message-type', { message: 1, code: 'RATE_LIMIT' }, /failure\.message/],
      ['message-empty', { message: '', code: 'RATE_LIMIT' }, /failure\.message/],
      ['code-type', { message: 'failed', code: 1 }, /failure\.code/],
      ['code-empty', { message: 'failed', code: '' }, /failure\.code/],
      ['status-type', { message: 'failed', code: 'RATE_LIMIT', status: 429.5 }, /failure\.status/],
      ['status-low', { message: 'failed', code: 'RATE_LIMIT', status: 99 }, /failure\.status/],
      ['status-high', { message: 'failed', code: 'RATE_LIMIT', status: 600 }, /failure\.status/],
      [
        'retry-after-type',
        { message: 'failed', code: 'RATE_LIMIT', providerRetryAfterMs: '25' },
        /failure\.providerRetryAfterMs/,
      ],
      [
        'retry-after-zero',
        { message: 'failed', code: 'RATE_LIMIT', providerRetryAfterMs: 0 },
        /failure\.providerRetryAfterMs/,
      ],
      ['request-id-type', { message: 'failed', code: 'RATE_LIMIT', requestId: 1 }, /failure\.requestId/],
      ['request-id-empty', { message: 'failed', code: 'RATE_LIMIT', requestId: '' }, /failure\.requestId/],
    ]
    for (const [name, invalidFailure, message] of invalidFailures) {
      const session = openStep(ctx, `fallback-invariant-failure-${name}`)
      expect(() => {
        session.append('llm/fallback', { ...switchData, failure: invalidFailure } as never)
      }).toThrow(message)
    }
  })

  it.each([
    ['same-entry switch', { ...switchData, toProvider: 'mock', toModel: 'mock' }, /switch to a different entry/],
    ['unknown reason', { ...switchData, reason: 'code' }, /reason must be threshold or probe/],
    ['negative cooldown', { ...switchData, cooldownMs: -1 }, /cooldownMs/],
    ['overflow cooldown', { ...switchData, cooldownMs: MAX_TIMER_DELAY_MS + 1 }, /cooldownMs/],
    ['cooldown type', { ...switchData, cooldownMs: '0' }, /cooldownMs/],
    ['empty head provider', { ...switchData, headProvider: '' }, /head provider must be a non-empty string/],
    ['empty head model', { ...switchData, headModel: '' }, /head model must be a non-empty string/],
    ['empty from provider', { ...switchData, fromProvider: '' }, /from provider must be a non-empty string/],
    ['empty from model', { ...switchData, fromModel: '' }, /from model must be a non-empty string/],
    ['empty to provider', { ...switchData, toProvider: '' }, /to provider must be a non-empty string/],
    ['empty to model', { ...switchData, toModel: '' }, /to model must be a non-empty string/],
  ])('rejects invalid switch data: %s', async (name, data, message) => {
    const ctx = await setup()
    const session = openStep(ctx, `fallback-invariant-${name}`)
    expect(() => {
      session.append('llm/fallback', data as never)
    }).toThrow(message)
  })

  it.each([
    ['empty head provider', { ...routeData, headProvider: '' }, /head provider must be a non-empty string/],
    ['empty head model', { ...routeData, headModel: '' }, /head model must be a non-empty string/],
    ['empty provider', { ...routeData, provider: '' }, /provider must be a non-empty string/],
    ['empty model', { ...routeData, model: '' }, /model must be a non-empty string/],
  ])('rejects invalid route data: %s', async (name, data, message) => {
    const ctx = await setup()
    const session = openStep(ctx, `fallback-route-${name}`)
    expect(() => {
      session.append('llm/fallback-route', data)
    }).toThrow(message)
  })

  it('rejects records outside the currently open turn and step', async () => {
    const ctx = await setup()
    const absent = ctx.sessions.create(SessionId('fallback-invariant-no-turn'))
    expect(() => {
      absent.append('llm/fallback', { ...switchData })
    }).toThrow(/inside an open turn/)

    const wrongTurn = openStep(ctx, 'fallback-invariant-wrong-turn')
    expect(() => {
      wrongTurn.append('llm/fallback', { ...switchData, turn: 2 })
    }).toThrow(/open turn is 1/)

    const closedStep = openStep(ctx, 'fallback-invariant-closed-step')
    closedStep.append('step/end', { turn: 1, step: 1 })
    expect(() => {
      closedStep.append('llm/fallback', { ...switchData })
    }).toThrow(/inside an open step/)

    const noStep = ctx.sessions.create(SessionId('fallback-invariant-no-step'))
    noStep.append('turn/start', { turn: 1 })
    expect(() => {
      noStep.append('llm/fallback', { ...switchData })
    }).toThrow(/inside an open step/)

    const wrongStep = openStep(ctx, 'fallback-invariant-wrong-step')
    expect(() => {
      wrongStep.append('llm/fallback', { ...switchData, step: 2 })
    }).toThrow(/open step is 1\/1/)

    const closedTurn = openStep(ctx, 'fallback-invariant-closed-turn')
    closedTurn.append('step/end', { turn: 1, step: 1 })
    closedTurn.append('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    expect(() => {
      closedTurn.append('llm/fallback', { ...switchData })
    }).toThrow(/inside an open turn/)

    const closedTurnRoute = openStep(ctx, 'fallback-route-closed-turn')
    closedTurnRoute.append('step/end', { turn: 1, step: 1 })
    closedTurnRoute.append('turn/end', {
      turn: 1,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })
    expect(() => {
      closedTurnRoute.append('llm/fallback-route', { ...routeData })
    }).toThrow(/inside an open turn/)
  })

  it('validates existing histories on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('fallback-invariant-late'))
    session.append('step/start', { turn: 1, step: 1 })
    session.append('llm/fallback', { ...switchData })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(FallbackInvariant)).rejects.toThrow(/inside an open turn/)
  })

  it('accepts valid existing histories on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = openStep(ctx, 'fallback-invariant-late-valid')
    session.append('llm/fallback', { ...switchData })
    session.append('llm/fallback-route', { ...routeData })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(FallbackInvariant)).resolves.toBeDefined()
  })
})
