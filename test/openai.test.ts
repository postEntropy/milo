import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../src/core/providers/openai'
import type { StreamEvent } from '../src/core/providers/types'

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
    async () =>
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
