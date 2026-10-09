import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from '../src/core/providers/anthropic.js'
import type { StreamEvent } from '../src/core/providers/types.js'

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

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
  const body = streamOf(chunks)
  const fetchMock = vi.fn(
    async (_url: string | URL, _init?: RequestInit) =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function collect(provider: AnthropicProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of provider.stream({
    model: 'claude-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    events.push(event)
  }
  return events
}

describe('AnthropicProvider', () => {
  it('parses thinking, text and tool_use blocks plus the stop reason', async () => {
    stubFetch([
      frame({ type: 'message_start', message: { usage: { input_tokens: 7 } } }),
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'pondering' },
      }),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
      frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } }),
      frame({ type: 'content_block_stop', index: 1 }),
      frame({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
      }),
      frame({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      }),
      frame({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '"a.txt"}' },
      }),
      frame({ type: 'content_block_stop', index: 2 }),
      frame({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 3 },
      }),
    ])

    const events = await collect(new AnthropicProvider({ id: 'test', baseURL: 'https://a.test/v1' }))

    expect(events.find((event) => event.type === 'reasoning')).toMatchObject({ delta: 'pondering' })
    expect(events.find((event) => event.type === 'text')).toMatchObject({ delta: 'Hi' })
    expect(events.find((event) => event.type === 'tool-call')).toMatchObject({
      id: 'toolu_1',
      name: 'read_file',
      args: { path: 'a.txt' },
    })
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls' })
  })

  it('reads the signature that follows a thought', async () => {
    stubFetch([
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'pondering' },
      }),
      frame({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-abc' },
      }),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ])

    const events = await collect(new AnthropicProvider({ id: 'test', baseURL: 'https://a.test/v1' }))

    expect(events.find((event) => event.type === 'reasoning-signature')).toMatchObject({
      signature: 'sig-abc',
    })
  })

  it('asks for a thinking budget, and leaves room to answer in', async () => {
    const fetchMock = stubFetch([frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })])

    for await (const _event of new AnthropicProvider({
      id: 'test',
      baseURL: 'https://a.test/v1',
    }).stream({
      model: 'claude-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.5,
      thinkingBudget: 2048,
    })) {
      // drain
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      thinking?: { type: string; budget_tokens: number }
      max_tokens: number
    }
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
    // A budget has to sit strictly below `max_tokens`.
    expect(body.max_tokens).toBeGreaterThan(2048)
    // Thinking is only compatible with the default temperature.
    expect(body).not.toHaveProperty('temperature')
  })

  it('sends no thinking when the request did not ask for it', async () => {
    const fetchMock = stubFetch([frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })])

    await collect(new AnthropicProvider({ id: 'test', baseURL: 'https://a.test/v1' }))

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('thinking')
  })

  it('replays a signed thought as a thinking block, and drops an unsigned one', async () => {
    const fetchMock = stubFetch([frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })])

    for await (const _event of new AnthropicProvider({
      id: 'test',
      baseURL: 'https://a.test/v1',
    }).stream({
      model: 'claude-test',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'signed thought', signature: 'sig-abc' },
            { type: 'reasoning', text: 'unsigned thought' },
            { type: 'text', text: 'the answer' },
          ],
        },
      ],
    })) {
      // drain
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: { role: string; content: { type: string }[] }[]
    }
    const assistant = body.messages.find((message) => message.role === 'assistant')!
    // The thought leads the turn, ahead of the text it belongs to.
    expect(assistant.content[0]).toEqual({
      type: 'thinking',
      thinking: 'signed thought',
      signature: 'sig-abc',
    })
    // A block the wire cannot verify is not one it may be sent.
    expect(JSON.stringify(body)).not.toContain('unsigned thought')
  })

  it('keeps the reasoning out of the request it sends back', async () => {
    const fetchMock = stubFetch([frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })])

    const provider = new AnthropicProvider({ id: 'test', baseURL: 'https://a.test/v1' })
    for await (const _event of provider.stream({
      model: 'claude-test',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'a private thought' },
            { type: 'text', text: 'the answer' },
          ],
        },
      ],
    })) {
      // drain
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: unknown[] }
    expect(JSON.stringify(body)).not.toContain('a private thought')
    expect(JSON.stringify(body.messages)).toContain('the answer')
  })

  it('refuses a stream that ended before the message was complete', async () => {
    // Text with no `message_delta` stop reason and no `message_stop`: the
    // connection dropped mid-answer, and the half that arrived is not an answer.
    stubFetch([
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } }),
      frame({ type: 'content_block_stop', index: 0 }),
    ])

    await expect(collect(new AnthropicProvider({ id: 'test', baseURL: 'https://a.test/v1' }))).rejects.toThrow(
      /before the message was complete/,
    )
  })
})
