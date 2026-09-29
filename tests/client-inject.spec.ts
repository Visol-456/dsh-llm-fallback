/**
 * Client-half inject declaration regression tests.
 *
 * Cordis resolves every mounted Remote namespace as its own service, so
 * `remote` and `remote.session` are two independent declarations. Reading a
 * namespace the fiber did not declare throws at *property access*:
 * `cannot get property "remote.session" without inject`. 0.1.7 shipped exactly
 * that — `FallbackSection` reads `api.session.modelCatalog()` for the
 * provider/model pickers while `src/client/index.ts` declared only `'remote'` —
 * so the `settings.section` slot outlet crashed on render and the Fallback
 * panel came up blank (the nav entry itself registers fine). These tests pin
 * the declaration to what the client half actually reads, and exercise the
 * registered section against a faithful imitation of that cordis guard.
 *
 * The slot outlet is not reachable from a plain unit test, so the coverage
 * half works on the sources: every `ctx.<service>` and every
 * `ctx.remote.<namespace>` / `api.<namespace>` access (`api` is the injected
 * wire face, `Pick<ClientRemote, 'session'>`) must be declared. The exact-set
 * assertions are deliberate: they keep a broken scan from passing vacuously.
 * @module test/client-inject
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/client/index.ts'
import type { FallbackSectionInjected } from '../src/client/FallbackSection.tsx'
import { FakeConfigForm } from './support/config-form.ts'

const CLIENT_ROOT = fileURLToPath(new URL('../src/client/', import.meta.url))

/** Every `.ts` / `.tsx` file of the client half, recursively. */
function clientSourceFiles(dir: string = CLIENT_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return clientSourceFiles(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Every client-half source, concatenated (the scan is file-agnostic). */
function clientSourceText(): string {
  return clientSourceFiles().map(file => readFileSync(file, 'utf8')).join('\n')
}

/**
 * Cordis context members that are core API rather than injectable services;
 * `ctx.effect` shows up in the client half and must not be demanded of inject.
 */
const CORDIS_CORE = new Set([
  'effect', 'on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall',
  'get', 'set', 'provide', 'accessor', 'mixin', 'inject', 'plugin', 'reflect',
  'fiber', 'registry', 'events', 'logger', 'root', 'scope', 'isolate',
  '$on', '$mount', '$', 'extend',
])

/** Service names the client half reads off a cordis context. */
function readServices(source: string = clientSourceText()): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    if (!CORDIS_CORE.has(match[1]!)) found.add(match[1]!)
  }
  return [...found].sort()
}

/** Remote namespaces the client half reads through the injected wire face. */
function readNamespaces(source: string = clientSourceText()): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/\b(?:ctx\.remote|api)\.([A-Za-z_$][\w$]*)/g)) {
    found.add(match[1]!)
  }
  return [...found].sort()
}

/**
 * Imitate the cordis context proxy for the Remote face: `remote.<namespace>`
 * is a service of its own, and touching one the fiber did not declare throws
 * the very message the 0.1.7 browser console reported.
 * @param declared - the fiber's inject list under test.
 * @param calls - counter incremented by every catalog read.
 * @returns the guarded `ctx.remote` stand-in.
 */
function remoteFace(declared: readonly string[], calls: { count: number }): Record<string, unknown> {
  const allowed = new Set(declared)
  return new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== 'string') return undefined
      const name = `remote.${property}`
      if (!allowed.has(name)) throw new Error(`cannot get property "${name}" without inject`)
      return {
        modelCatalog: async () => {
          calls.count += 1
          return { groups: [] }
        },
      }
    },
  })
}

/** One `settings.section` registration observed at the slot boundary. */
interface RegisteredSection {
  id: string
  inject: () => FallbackSectionInjected
}

/**
 * Run the real `apply` against a minimal ctx whose Remote face enforces
 * `declared`, and hand back what the slot boundary received.
 * @param declared - inject list the fake fiber runs with.
 * @returns the ctx, the registrations, and the guarded catalog call counter.
 */
function mountWith(declared: readonly string[]): {
  ctx: unknown
  registered: RegisteredSection[]
  calls: { count: number }
} {
  const registered: RegisteredSection[] = []
  const calls = { count: 0 }
  const form = new FakeConfigForm({ fallbacks: [{ provider: 'pi-ai', model: 'glm-4.5' }] })

  const ctx = {
    effect: (run: () => unknown) => { run(); return () => {} },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    configForms: {
      whileServed: (_namespaces: readonly string[], run: () => unknown) => run(),
      get: () => form,
      describe: () => ({ ensure: async () => {} }),
    },
    slots: {
      inject: (_name: string, run: () => unknown) => run(),
      register: (declaration: RegisteredSection) => {
        registered.push(declaration)
        return () => {}
      },
    },
    remote: remoteFace(declared, calls),
  }
  return { ctx, registered, calls }
}

describe('client inject declaration', () => {
  it('declares every cordis service the client half reads off the context', () => {
    const services = readServices()
    expect(services).toEqual(['configForms', 'locale', 'remote', 'slots'])
    for (const service of services) expect(inject).toContain(service)
  })

  it('declares every Remote namespace the client half reads through the wire face', () => {
    const namespaces = readNamespaces()
    expect(namespaces).toEqual(['session'])
    for (const namespace of namespaces) expect(inject).toContain(`remote.${namespace}`)
  })

  it('keeps remote.session declared alongside remote, the two-service gotcha', () => {
    expect(inject).toContain('remote')
    expect(inject).toContain('remote.session')
  })
})

describe('settings section under the cordis namespace guard', () => {
  it('registers and reads remote.session with the shipped declaration', async () => {
    const { ctx, registered, calls } = mountWith(inject)
    apply(ctx as unknown as ClientContext)

    expect(registered.map(section => section.id)).toEqual(['llm-fallback'])
    const face = registered[0]!.inject()
    await expect(face.api.session.modelCatalog()).resolves.toEqual({ groups: [] })
    expect(calls.count).toBe(1)
  })

  it('reproduces the 0.1.7 crash when remote.session is not declared', () => {
    const broken = inject.filter(name => name !== 'remote.session')
    expect(broken).toContain('remote')
    expect(broken).not.toContain('remote.session')

    const { ctx, registered } = mountWith(broken)
    apply(ctx as unknown as ClientContext)

    const face = registered[0]!.inject()
    expect(() => face.api.session).toThrow('cannot get property "remote.session" without inject')
  })
})
