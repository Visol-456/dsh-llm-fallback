import { describe, expect, it } from 'vitest'
import { FallbackCircuit } from '../src/circuit.ts'
import type { ResolvedFallbackChain } from '../src/circuit.ts'

const chain: ResolvedFallbackChain = Object.freeze({
  fallbacks: Object.freeze([
    { provider: 'other', model: 'other' },
    { provider: 'biz', model: 'biz' },
  ]),
  switchCodes: Object.freeze(['SERVER']),
  failureThreshold: 1,
  cooldownMs: 0,
})

const failure = { message: 'busy', code: 'SERVER' }

describe('FallbackCircuit', () => {
  it('serves a new request as the head without rewriting it', () => {
    const circuit = new FallbackCircuit(chain, () => 0)
    expect(circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' }))
      .toEqual({ entry: { provider: 'mock', model: 'mock' }, fallback: false })
    expect(circuit.head()).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('switches the head to the first fallback and pins the retry to it', () => {
    const circuit = new FallbackCircuit(chain, () => 0)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      from: { provider: 'mock' },
      to: { provider: 'other' },
      reason: 'threshold',
    })
    // The retried request of the same step serves the fallback.
    expect(circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' }))
      .toEqual({ entry: { provider: 'other', model: 'other' }, fallback: true })
    // A brand-new step serves the head again.
    expect(circuit.route('agent-1', 2, 1, { provider: 'mock', model: 'mock' }))
      .toEqual({ entry: { provider: 'mock', model: 'mock' }, fallback: false })
  })

  it('charges only failures whose provider matches the serving entry', () => {
    const circuit = new FallbackCircuit(chain, () => 0)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'other', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
    })
  })

  it('keeps charging head failures below the threshold without switching', () => {
    const circuit = new FallbackCircuit({ ...chain, failureThreshold: 3 }, () => 0)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
      reason: 'threshold',
    })
  })

  it('ignores non-switchable failures without counting them', () => {
    const circuit = new FallbackCircuit(chain, () => 0)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', { ...failure, code: 'AUTH' })).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
    })
  })

  it('advances through the fallbacks and never switches on the last one', () => {
    const circuit = new FallbackCircuit(chain, () => 0)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({ to: { provider: 'other' } })
    // The retry of the same step now serves the first fallback.
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'other', failure)).toMatchObject({ to: { provider: 'biz' } })
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'biz', failure)).toBeUndefined()
  })

  it('serves the fallback in service while the head is still cooling down', () => {
    let time = 0
    const circuit = new FallbackCircuit({ ...chain, cooldownMs: 60_000 }, () => time)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
      reason: 'threshold',
    })
    // A new request during the cooldown tries the head and fails over to the
    // fallback currently in service (no threshold re-accounting).
    circuit.route('agent-1', 2, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 2, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
      reason: 'probe',
    })
  })

  it('re-opens the circuit on one failed probe after the cooldown expired', () => {
    let time = 0
    const circuit = new FallbackCircuit({
      ...chain,
      failureThreshold: 3,
      cooldownMs: 60_000,
    }, () => time)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
      reason: 'threshold',
    })

    time = 60_001
    // Cooldown expired: the next request probes the head; one failure reopens.
    circuit.route('agent-1', 2, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 2, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
      reason: 'probe',
    })
  })

  it('accumulates the threshold from zero again after a successful head probe', () => {
    let time = 0
    const circuit = new FallbackCircuit({
      ...chain,
      failureThreshold: 2,
      cooldownMs: 60_000,
    }, () => time)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    circuit.recordFailure('agent-1', 1, 1, 'mock', failure)
    circuit.recordFailure('agent-1', 1, 1, 'mock', failure)

    time = 60_001
    circuit.route('agent-1', 2, 1, { provider: 'mock', model: 'mock' })
    circuit.recordSuccess('mock', 'mock')

    // A post-recovery failure is not a probe: it must accumulate against the
    // threshold instead of re-opening the circuit immediately.
    expect(circuit.recordFailure('agent-1', 3, 1, 'mock', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 3, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
      reason: 'threshold',
    })
  })

  it('resets only the fallback that answered successfully', () => {
    const circuit = new FallbackCircuit({ ...chain, failureThreshold: 2 }, () => 0)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    circuit.recordFailure('agent-1', 1, 1, 'mock', failure)
    circuit.recordFailure('agent-1', 1, 1, 'mock', failure)
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    // One failure on the first fallback; a success on a different provider
    // must not clear it (it would still need one more failure to advance).
    circuit.recordFailure('agent-1', 1, 1, 'other', failure)
    circuit.recordSuccess('biz', 'biz')
    circuit.route('agent-1', 1, 1, { provider: 'mock', model: 'mock' })
    expect(circuit.recordFailure('agent-1', 1, 1, 'other', failure)).toMatchObject({
      to: { provider: 'biz' },
    })
  })
})
