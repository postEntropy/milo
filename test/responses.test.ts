import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResponsesProvider } from '../src/core/providers/responses.js'
import type { StreamEvent } from '../src/core/providers/types.js'

const frame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function stubFetch(chunks: string[]) {
  const fetchMock = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(streamOf(chunks), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function collect(provider: ResponsesProvider, request: Parameters<ResponsesProvider['stream']>[0] = {
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of provider.stream(request)) events.push(event)
  return events
}

describe('ResponsesProvider', () => {
  it('streams text and a tool call from the Responses wire', async () => {
    const fetchMock = stubFetch([
      frame({ type: 'response.reasoning_summary_text.delta', delta: 'think' }),
      frame({ type: 'response.output_text.delta', delta: 'Hello' }),
      frame({ type: 'response.output_text.delta', delta: ' world' }),
      frame({
        type: 'response.output_item.done',
        item: {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'gAAA',
          summary: [{ type: 'summary_text', text: 'think' }],
        },
      }),
      frame({
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"x"}' },
      }),
      frame({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 }, output: [] },
      }),
    ])

    const provider = new ResponsesProvider({
      id: 'chatgpt',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'token',
      headers: {},
    })
    const events = await collect(provider)

    expect(events.filter((event) => event.type === 'text').map((event) => event.type === 'text' && event.delta)).toEqual(['Hello', ' world'])
    expect(events.find((event) => event.type === 'reasoning')).toMatchObject({ type: 'reasoning', delta: 'think' })
    expect(events.find((event) => event.type === 'reasoning-signature')).toMatchObject({
      type: 'reasoning-signature',
      signature: JSON.stringify({ id: 'rs_1', encrypted_content: 'gAAA', summary: [{ type: 'summary_text', text: 'think' }] }),
    })
    expect(events.find((event) => event.type === 'tool-call')).toMatchObject({
      type: 'tool-call',
      id: 'call_1',
      name: 'read_file',
      args: { path: 'x' },
    })
    expect(events.find((event) => event.type === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls' })

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'test-model',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
    })
  })

  it('replays signed reasoning and tool results as Responses items', async () => {
    const fetchMock = stubFetch([
      frame({ type: 'response.completed', response: { status: 'completed', output: [] } }),
    ])
    const provider = new ResponsesProvider({
      id: 'chatgpt',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'token',
    })

    await collect(provider, {
      model: 'test-model',
      system: 'be brief',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read it' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'plan', signature: JSON.stringify({ id: 'rs_1', encrypted_content: 'gAAA', summary: [] }) },
            { type: 'tool-call', id: 'call_1', name: 'read_file', args: { path: 'x' } },
          ],
        },
        { role: 'tool', content: [{ type: 'tool-result', id: 'call_1', name: 'read_file', content: 'body' }] },
      ],
    })

    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(String(init?.body)) as { instructions: string; input: unknown[] }
    expect(body.instructions).toBe('be brief')
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'gAAA', summary: [] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"x"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'body' },
    ])
  })

  it('asks with a fresh token once when the first one is refused', async () => {
    const responses = [
      new Response('{"error":{"message":"expired"}}', { status: 401 }),
      new Response(streamOf([frame({ type: 'response.completed', response: { status: 'completed', output: [] } })]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    ]
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => responses.shift()!)
    vi.stubGlobal('fetch', fetchMock)
    const token = vi.fn(async (force?: boolean) => ({ token: force ? 'fresh' : 'stale', accountId: 'acct_1' }))

    const provider = new ResponsesProvider({
      id: 'chatgpt',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      token,
    })
    const events = await collect(provider)

    expect(token.mock.calls).toEqual([[false], [true]])
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' })
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer fresh',
      'chatgpt-account-id': 'acct_1',
      originator: 'codex_cli_rs',
    })
  })

  it('refuses a stream that ends without a completed response', async () => {
    stubFetch([frame({ type: 'response.output_text.delta', delta: 'half' })])
    const provider = new ResponsesProvider({ id: 'chatgpt', baseURL: 'https://example.test', apiKey: 'k' })

    await expect(collect(provider)).rejects.toThrow('ended before the message was complete')
  })
})
