/**
 * Browser-configuration bridge for the `llm-fallback` settings namespace.
 *
 * The harness settings wire (`api.settings.*`) only serves namespaces on the
 * apiproxy allowlist, so this plugin owns one exact HTTP route on the shared
 * `webServer` seat: GET returns the resolved namespace view (defaults ->
 * cordis.yml base -> saved user section), PUT replaces the user section
 * (revision-fenced), DELETE clears it back to pure cordis.yml behavior. All
 * writes go through the same settings seam the CLI-facing surface uses, so
 * the section lands in `<DSH_HOME>/settings.yaml` with atomic, lock-guarded
 * persistence and external-edit hot-publish for free.
 *
 * Trust: the route is guarded, not authenticated. Every request must come
 * from a loopback socket and must not look cross-site; when the web server is
 * bound to 0.0.0.0 this still admits the local browser (127.0.0.1) while
 * refusing LAN clients, but the guard is a miswrite/cross-site fence, not an
 * auth layer.
 *
 * @module @deepseek-ai/dsh-llm-fallback/config-http
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  SettingsConflictError,
  settingsNamespace,
  type SettingsDescriptor,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
// Type-only: pulls the `ctx.webServer` Context merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Route path owning every config-bridge request. */
export const CONFIG_PATH = '/llm-fallback/config'

/** Settings namespace owned by the fallback plugin. */
export const FALLBACK_SETTINGS_NAMESPACE = settingsNamespace('llm-fallback')

/** Maximum request body the bridge accepts (the section is small by nature). */
const MAX_BODY_BYTES = 1024 * 1024

/** Wire view of one namespace descriptor, redacted by the seam already. */
export interface FallbackConfigView {
  /** Whether a settings provider serves the namespace. */
  available: boolean
  /** Whether the settings provider accepts writes. */
  writable: boolean
  /** Whether the provider owns a local user-editable document. */
  hasDocument: boolean
  /** Resolved value: schema defaults, then base, then the user section. */
  value: unknown
  /** Composition base layer (cordis.yml entry), when one was declared. */
  base?: unknown
  /** Raw saved user section, when one exists. */
  user?: unknown
  /** Monotonic revision of the raw user section; send back to fence a write. */
  revision: number
}

/** Wire error the bridge returns on a rejected write. */
export interface ConfigBridgeError {
  error: {
    /** Stable machine code: `settings-conflict` or `settings-rejected`. */
    code: 'settings-conflict' | 'settings-rejected'
    /** Human message from the settings seam. */
    message: string
  }
}

/** Whether a socket peer address is the loopback interface (v4, v6, v4-mapped). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '127.0.0.1' || address === '::1') return true
  const mapped = '::ffff:'
  if (address.startsWith(mapped)) return address.slice(mapped.length) === '127.0.0.1'
  return false
}

/**
 * Decide whether one request may reach the bridge. All three conditions must
 * hold: the socket peer is loopback, the browser marks the request not
 * cross-site, and an attached Origin equals the Host authority.
 * @param request - the incoming request.
 * @returns whether the request is trusted.
 */
export function isTrustedBridgeRequest(request: IncomingMessage): boolean {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers['origin']
  if (origin === undefined) return true
  const host = request.headers['host']
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read a bounded JSON request body. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.length
    if (received > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Write one JSON response. */
function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/** Whether a stored section carries no keys (a reset leaves an empty object). */
function isEmptySection(section: unknown): boolean {
  return typeof section === 'object' && section !== null && !Array.isArray(section)
    && Object.keys(section as Record<string, unknown>).length === 0
}

/** Project one descriptor to its wire view. */
function viewOf(descriptor: SettingsDescriptor, settings: { writable: boolean; hasDocument: boolean }): FallbackConfigView {
  return {
    available: true,
    writable: settings.writable,
    hasDocument: settings.hasDocument,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined || isEmptySection(descriptor.user) ? {} : { user: descriptor.user },
    revision: descriptor.revision,
  }
}

/** The namespace's current descriptor, when the provider serves it. */
function descriptorOf(ctx: Context, ns: SettingsNamespace): SettingsDescriptor | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  return settings.describe({ redactSecrets: true }).find(candidate => candidate.ns === ns)
}

/** Write one namespaced setting and answer with the new view. */
async function writeSection(
  ctx: Context,
  ns: SettingsNamespace,
  section: Record<string, unknown>,
  expectedRevision: number | undefined,
  res: ServerResponse,
): Promise<void> {
  const settings = ctx.get('settings')
  if (settings === undefined) {
    json(res, 503, {
      error: { code: 'settings-rejected', message: 'llm-fallback: no settings provider is mounted in this deployment' },
    } satisfies ConfigBridgeError)
    return
  }
  try {
    await settings.replace(ns, section, expectedRevision)
  } catch (error) {
    if (error instanceof SettingsConflictError) {
      json(res, 409, {
        error: {
          code: 'settings-conflict',
          message: `llm-fallback: configuration changed elsewhere (expected revision ${String(error.expected)}, current ${String(error.actual)}); reload and retry`,
        },
      } satisfies ConfigBridgeError)
      return
    }
    json(res, 400, {
      error: {
        code: 'settings-rejected',
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies ConfigBridgeError)
    return
  }
  const descriptor = descriptorOf(ctx, ns)
  if (descriptor === undefined) {
    json(res, 500, { error: { code: 'settings-rejected', message: 'llm-fallback: namespace vanished after write' } } satisfies ConfigBridgeError)
    return
  }
  json(res, 200, viewOf(descriptor, { writable: settings.writable, hasDocument: settings.documentPath !== undefined }))
}

/**
 * Handle one config-bridge request.
 * @param ctx - plugin context carrying the settings and webServer services.
 * @param request - the incoming node:http request.
 * @param res - the response to write.
 */
export async function handleConfigBridge(ctx: Context, request: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isTrustedBridgeRequest(request)) {
    res.writeHead(403)
    res.end()
    return
  }
  const method = request.method ?? 'GET'
  if (method === 'GET') {
    const descriptor = descriptorOf(ctx, FALLBACK_SETTINGS_NAMESPACE)
    if (descriptor === undefined) {
      const settings = ctx.get('settings')
      json(res, 200, {
        available: false,
        writable: settings?.writable ?? false,
        hasDocument: settings?.documentPath !== undefined,
        value: undefined,
        revision: 0,
      } satisfies FallbackConfigView)
      return
    }
    const settings = ctx.get('settings')
    json(res, 200, viewOf(descriptor, {
      writable: settings?.writable ?? false,
      hasDocument: settings?.documentPath !== undefined,
    }))
    return
  }
  if (method === 'PUT' || method === 'DELETE') {
    let section: Record<string, unknown>
    let expectedRevision: number | undefined
    if (method === 'PUT') {
      let body: unknown
      try {
        body = await readJson(request)
      } catch (error) {
        json(res, 400, { error: { code: 'settings-rejected', message: `llm-fallback: invalid request body: ${error instanceof Error ? error.message : String(error)}` } } satisfies ConfigBridgeError)
        return
      }
      const parsed = body as { section?: unknown; expectedRevision?: unknown } | undefined
      if (typeof parsed !== 'object' || parsed === null
        || typeof parsed.section !== 'object' || parsed.section === null || Array.isArray(parsed.section)) {
        json(res, 400, { error: { code: 'settings-rejected', message: 'llm-fallback: PUT requires {"section": {...}}' } } satisfies ConfigBridgeError)
        return
      }
      section = parsed.section as Record<string, unknown>
      expectedRevision = typeof parsed.expectedRevision === 'number' ? parsed.expectedRevision : undefined
    } else {
      section = {}
    }
    await writeSection(ctx, FALLBACK_SETTINGS_NAMESPACE, section, expectedRevision, res)
    return
  }
  res.writeHead(405)
  res.end()
}

/**
 * Register the config bridge on the shared web server.
 * @param ctx - plugin context (must have the `webServer` service injected).
 * @returns the disposer removing the route.
 */
export function registerConfigBridge(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: (req, res) => void handleConfigBridge(ctx, req, res),
  })
}
