import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ResponsesProvider } from '../src/core/providers/responses.js'
import type { StreamEvent } from '../src/core/providers/types.js'

let server: Server | null = null

afterEach(async () => {
  if (!server) return
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

describe('ResponsesProvider over a socket', () => {
  it('sends the Responses request and reads its stream', async () => {
    let seen: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> } | null = null
    server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      request.on('end', () => {
        seen = {
          headers: request.headers,
          body: JSON.parse(raw) as Record<string, unknown>,
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (event: unknown): void => {
          response.write(`data: ${JSON.stringify(event)}\n\n`)
        }
        send({ type: 'response.reasoning_summary_text.delta', delta: 'plan' })
        send({ type: 'response.output_text.delta', delta: 'hello' })
        send({ type: 'response.output_text.delta', delta: ' world' })
        send({
          type: 'response.output_item.done',
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list_files', arguments: '{"path":"."}' },
        })
        send({
          type: 'response.completed',
          response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 3 }, output: [] },
        })
        response.end()
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port

    const provider = new ResponsesProvider({
      id: 'local',
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
      headers: { 'x-test': 'yes' },
    })
    const events: StreamEvent[] = []
    for await (const event of provider.stream({
      model: 'gpt-test',
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'list_files', description: 'List files', parameters: { type: 'object' } }],
      reasoningEffort: 'low',
      maxTokens: 128,
    })) {
      events.push(event)
    }

    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', delta: 'hello' },
      { type: 'text', delta: ' world' },
    ])
    expect(events.find((event) => event.type === 'tool-call')).toMatchObject({
      type: 'tool-call',
      id: 'call_1',
      name: 'list_files',
      args: { path: '.' },
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls' })

    expect(seen!.headers.authorization).toBe('Bearer test-key')
    expect(seen!.headers['x-test']).toBe('yes')
    expect(seen!.body).toMatchObject({
      model: 'gpt-test',
      instructions: 'be brief',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 128,
      reasoning: { effort: 'low', summary: 'auto' },
      tools: [{ type: 'function', name: 'list_files', description: 'List files', parameters: { type: 'object' }, strict: false }],
    })
  })
})
