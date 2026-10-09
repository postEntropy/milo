import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../src/core/providers/openai.js'
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

async function collect(provider: OpenAIProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of provider.stream({
    model: 'test-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    events.push(event)
  }
  return events
}

describe('OpenAIProvider', () => {
  it('streams text and reassembles fragmented tool calls', async () => {
    stubFetch([
      frame({ choices: [{ delta: { reasoning_content: 'hmm,' } }] }),
      frame({ choices: [{ delta: { content: 'Hello' } }] }),
      frame({ choices: [{ delta: { content: ' world' } }] }),
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } },
              ],
            },
          },
        ],
      }),
      frame({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x.txt"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      frame({ usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ])

    const provider = new OpenAIProvider({
      id: 'test',
      baseURL: 'https://example.test/v1',
      apiKey: 'k',
    })
    const events = await collect(provider)

    const text = events
      .filter((event): event is { type: 'text'; delta: string } => event.type === 'text')
      .map((event) => event.delta)
      .join('')
    expect(text).toBe('Hello world')

    expect(events.find((event) => event.type === 'reasoning')).toMatchObject({ delta: 'hmm,' })

    const toolCall = events.find((event) => event.type === 'tool-call')
    expect(toolCall).toMatchObject({ id: 'call_1', name: 'read_file', args: { path: 'x.txt' } })

    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls' })
  })

  it('takes the thought from `reasoning` when `reasoning_content` is empty', async () => {
    stubFetch([
      // A router that fills both fields, one of them blank. The blank one used
      // to win, and the thought vanished without a sign on the wire.
      frame({ choices: [{ delta: { reasoning_content: '', reasoning: 'pondering' } }] }),
      frame({ choices: [{ delta: { content: 'done' } }] }),
      'data: [DONE]\n\n',
    ])

    const provider = new OpenAIProvider({
      id: 'test',
      baseURL: 'https://example.test/v1',
    })

    const events = await collect(provider)
    expect(events.find((event) => event.type === 'reasoning')).toMatchObject({ delta: 'pondering' })
  })

  it('keeps the reasoning out of the request it sends back', async () => {
    const fetchMock = stubFetch([
      frame({ choices: [{ delta: { content: 'ok' } }] }),
      'data: [DONE]\n\n',
    ])

    const provider = new OpenAIProvider({
      id: 'test',
      baseURL: 'https://example.test/v1',
      apiKey: 'k',
    })
    for await (const _event of provider.stream({
      model: 'test-model',
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

  it('asks for the effort it was given, and for nothing when it was not', async () => {
    // A fresh body per call: this test makes two requests, and a Response body
    // can only be read once.
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(streamOf([frame({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const provider = new OpenAIProvider({ id: 'test', baseURL: 'https://example.test/v1' })

    const drain = async (reasoningEffort?: 'low' | 'medium' | 'high') => {
      for await (const _event of provider.stream({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        reasoningEffort,
      })) {
        // drain
      }
      return JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as Record<string, unknown>
    }

    expect((await drain('low')).reasoning_effort).toBe('low')
    // Absent means the provider's default: the request says nothing about it.
    expect(await drain()).not.toHaveProperty('reasoning_effort')
  })

  it('refuses a stream that ended before the message was complete', async () => {
    // Content with neither a finish reason nor `[DONE]`: the stream was cut
    // mid-token, and the fragment that arrived must not read as an answer.
    stubFetch([frame({ choices: [{ delta: { content: 'half' } }] })])

    await expect(collect(new OpenAIProvider({ id: 'test', baseURL: 'https://example.test/v1' }))).rejects.toThrow(
      /before the message was complete/,
    )
  })

  it('throws a clear error on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' })),
    )
    const provider = new OpenAIProvider({
      id: 'test',
      baseURL: 'https://example.test/v1',
      apiKey: 'bad',
    })
    await expect(collect(provider)).rejects.toThrow(/401/)
  })
})
