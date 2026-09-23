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
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ),
  )
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
})
