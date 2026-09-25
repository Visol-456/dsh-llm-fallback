/**
 * Test support: a minimal Anthropic Messages SSE fixture for the pi-ai
 * adapter. `@earendil-works/pi-ai` streams through the Anthropic SDK, whose
 * parser dispatches on the SSE `event:` name, while
 * `@deepseek-ai/dsh-llm-mock-server` deliberately emits data-only frames for
 * the harness's own Messages adapter. This fixture answers one successful
 * turn in the named-event framing the SDK requires, and records every request
 * so a test can assert what crossed the wire.
 * @module test/support/messages-server
 */

import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One captured request. */
export interface FixtureRequest {
  /** Request path (including any `/v1` prefix). */
  readonly path: string
  /** Detached request headers. */
  readonly headers: IncomingHttpHeaders
  /** Parsed JSON request body. */
  readonly body: unknown
}

/** Running fixture server. */
export interface FixtureMessagesServer {
  /** Base URL without `/v1`; the endpoint is `/v1/messages`. */
  readonly baseURL: string
  /** Live request records in arrival order. */
  readonly requests: FixtureRequest[]
  /** Stop listening. */
  close(): Promise<void>
}

/** Read a bounded JSON request body. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * Start the fixture.
 * @param options - assistant text to serve and the exact `x-api-key` accepted.
 * @returns the listening handle.
 */
export async function startMessagesServer(options: {
  text: string
  apiKey?: string
}): Promise<FixtureMessagesServer> {
  const requests: FixtureRequest[] = []
  const server = createServer((request, response) => {
    void handle(request, response)
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname
    if (request.method !== 'POST' || !path.endsWith('/v1/messages')) {
      response.writeHead(404).end()
      return
    }
    if (options.apiKey !== undefined && request.headers['x-api-key'] !== options.apiKey) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } }))
      return
    }
    requests.push({ path, headers: request.headers, body: await readJson(request) })

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event: string, data: unknown): void => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'fixture-message',
        type: 'message',
        role: 'assistant',
        model: 'mock-model',
        content: [],
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    })
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: options.text },
    })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 12 },
    })
    send('message_stop', { type: 'message_stop' })
    response.end()
  }

  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}
