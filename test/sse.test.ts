import { describe, expect, it } from 'vitest'
import { parseSSE } from '../src/core/providers/sse'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: { event?: string; data: string }[] = []
  for await (const message of parseSSE(stream)) out.push(message)
  return out
}

describe('parseSSE', () => {
  it('yields data payloads split across chunks', async () => {
    const messages = await collect(streamOf(['data: {"a":1}\n\ndata: {"b":', '2}\n\n']))
    expect(messages.map((message) => message.data)).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('captures the event name that precedes a payload', async () => {
    const messages = await collect(
      streamOf(['event: message_start\ndata: {"type":"message_start"}\n\n']),
    )
    expect(messages[0]).toMatchObject({
      event: 'message_start',
      data: '{"type":"message_start"}',
    })
  })

  it('ignores comments and blank lines', async () => {
    const messages = await collect(streamOf([': keep-alive\n\ndata: hello\n\n']))
    expect(messages.map((message) => message.data)).toEqual(['hello'])
  })
})
