/**
 * Test support: a faithful minimal double of the harness configuration form
 * (`@deepseek-ai/dsh-client-ui-settings/client`). The real controller owns a
 * browser module-loader bundle surface over the Remote wire, so the page's
 * contract is reproduced here: one snapshot, one write lane, one revision
 * fence, and the refusal/rejection outcomes the page renders.
 * @module test/support/config-form
 */

import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Create a form double over one section value. */
export class FakeConfigForm implements ConfigForm<unknown> {
  /** Every mutation queued through this form, in order. */
  readonly mutations: SettingsPathOpView[][] = []
  /** Answer the next mutation with a refusal (Host rejection). */
  refuse = false
  /** Reject the next mutation instead of answering (transport failure). */
  failure: Error | undefined
  /** Move the revision on refusal, as a concurrent host write would. */
  revisionOnRefusal = 0

  private snapshot: ConfigFormSnapshot<unknown>
  private readonly listeners = new Set<() => void>()

  /**
   * @param value - the section value the form currently holds.
   * @param options - writable flag, revision, and mode.
   */
  constructor(
    value: unknown,
    options: { writable?: boolean; revision?: number; mode?: 'host' | 'memory'; status?: 'ready' | 'unavailable' } = {},
  ) {
    this.snapshot = {
      status: options.status ?? 'ready',
      value,
      base: undefined,
      user: undefined,
      revision: options.revision ?? 0,
      writable: options.writable ?? true,
      mode: options.mode ?? 'host',
    }
  }

  getSnapshot(): ConfigFormSnapshot<unknown> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async set(field: string, value: unknown): Promise<boolean> {
    return this.mutate([{ op: 'set', path: [field], value: value as JsonValue }])
  }

  async unset(field: string): Promise<boolean> {
    return this.mutate([{ op: 'unset', path: [field] }])
  }

  async mutate(ops: readonly SettingsPathOpView[]): Promise<boolean> {
    this.mutations.push([...ops])
    if (this.failure !== undefined) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    if (this.refuse) {
      this.refuse = false
      // A refused write reloads host state: the revision the next write must
      // fence against is the reloaded one.
      this.publish({ revision: (this.snapshot.revision ?? 0) + 1 + this.revisionOnRefusal })
      return false
    }
    const value = structuredClone(this.snapshot.value) as Record<string, unknown>
    for (const op of ops) {
      if (op.op === 'set') value[op.path[0]!] = op.value
      else delete value[op.path[0]!]
    }
    this.publish({ value, revision: (this.snapshot.revision ?? 0) + 1 })
    return true
  }

  private publish(patch: Partial<ConfigFormSnapshot<unknown>>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }
}
