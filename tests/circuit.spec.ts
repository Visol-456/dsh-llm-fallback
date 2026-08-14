import { describe, expect, it } from 'vitest'
import { FallbackCircuit } from '../src/circuit.ts'
import type { ResolvedFallbackChain } from '../src/circuit.ts'

const chain: ResolvedFallbackChain = Object.freeze({
  entries: Object.freeze([
    { provider: 'mock', model: 'mock' },
    { provider: 'other', model: 'other' },
  ]),
  switchCodes: Object.freeze(['SERVER']),
  failureThreshold: 1,
  cooldownMs: 0,
})

const failure = { message: 'busy', code: 'SERVER' }

describe('FallbackCircuit', () => {
  it('routes nothing for a request that matches no entry', () => {
    const circuit = new FallbackCircuit(chain, () => 0)
    expect(circuit.route('agent-1', 1, 1, { provider: 'unrelated', model: 'x' })).toBeUndefined()
  })

  it('resets the consecutive count only for the serving entry that answered', () => {
    const circuit = new FallbackCircuit({
      ...chain,
      failureThreshold: 2,
    }, () => 0)
    circuit.recordFailure('agent-1', 1, 1, 'mock', failure)
    circuit.recordSuccess('other')
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      from: { provider: 'mock' },
      to: { provider: 'other' },
    })

    const reset = new FallbackCircuit({ ...chain, failureThreshold: 2 }, () => 0)
    reset.recordFailure('agent-1', 1, 1, 'mock', failure)
    reset.recordSuccess('mock')
    expect(reset.recordFailure('agent-1', 1, 1, 'mock', failure)).toBeUndefined()
    expect(reset.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
    })
  })

  it('charges only failures whose provider matches the serving entry', () => {
    const circuit = new FallbackCircuit(chain, () => 0)
    expect(circuit.recordFailure('agent-1', 1, 1, 'other', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
    })
  })

  it('keeps charging failures below the threshold without switching', () => {
    const circuit = new FallbackCircuit({ ...chain, failureThreshold: 3 }, () => 0)
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 1, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
      reason: 'threshold',
    })
  })

  it('accumulates the threshold from zero again after a successful probe', () => {
    let time = 0
    const circuit = new FallbackCircuit({
      ...chain,
      failureThreshold: 2,
      cooldownMs: 60_000,
    }, () => time)
    circuit.recordFailure('agent-1', 1, 1, 'mock', failure)
    circuit.recordFailure('agent-1', 1, 1, 'mock', failure)

    time = 60_001
    // Cooldown expired: the next request re-derives to the head (the probe).
    expect(circuit.route('agent-1', 2, 1, { provider: 'mock', model: 'mock' }))
      .toEqual({ entry: { provider: 'mock', model: 'mock' }, fallback: false })
    circuit.recordSuccess('mock')

    // A post-recovery failure is not a probe: it must accumulate against the
    // threshold instead of re-opening the circuit immediately.
    expect(circuit.recordFailure('agent-1', 3, 1, 'mock', failure)).toBeUndefined()
    expect(circuit.recordFailure('agent-1', 3, 1, 'mock', failure)).toMatchObject({
      to: { provider: 'other' },
      reason: 'threshold',
    })
  })

  it('never switches on the last entry even at or above the threshold', () => {
    const circuit = new FallbackCircuit({
      ...chain,
      cooldownMs: 60_000,
    }, () => 0)
    circuit.recordFailure('agent-1', 1, 1, 'mock', failure)
    expect(circuit.recordFailure('agent-1', 1, 1, 'other', failure)).toBeUndefined()
    expect(circuit.route('agent-1', 2, 1, { provider: 'other', model: 'other' }))
      .toEqual({ entry: { provider: 'other', model: 'other' }, fallback: true })
  })
})
