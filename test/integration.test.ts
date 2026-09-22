import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events'
import { FileMemory } from '../src/core/memory/local'
import { createProvider } from '../src/core/providers/create'
import { AgentRuntime } from '../src/core/runtime'
import { createToolRegistry } from '../src/core/tools'

let server: Server
let baseURL: string
let calls = 0

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => undefined)
    req.on('end', () => {
      calls += 1
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (calls === 1) {
        res.write(frame({ choices: [{ delta: { content: 'Let me read it. ' } }] }))
        res.write(
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'package.json' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        )
        res.write(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
      } else {
        res.write(frame({ choices: [{ delta: { content: 'The package is called milo.' } }] }))
        res.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseURL = `http://127.0.0.1:${port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('end-to-end turn', () => {
  it('streams, runs a tool, continues, and remembers the exchange', async () => {
    calls = 0
    const memory = new FileMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-it-')) })
    const runtime = new AgentRuntime({
      provider: createProvider({ id: 'local', baseURL, apiKey: false, wire: 'openai' }, 'test-model'),
      model: 'test-model',
      system: 'You are a test agent.',
      registry: createToolRegistry(),
      memory,
      cwd: process.cwd(),
    })

    const scope = { gateway: 'cli', conversationId: 'it' }
    const session = runtime.getSession(scope)

    const events: AgentEvent[] = []
    for await (const event of session.send('what is the package called?')) events.push(event)

    const text = events
      .filter((event): event is { type: 'text-delta'; delta: string } => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(text).toContain('Let me read it.')
    expect(text).toContain('milo')

    const toolEnd = events.find(
      (event): event is Extract<AgentEvent, { type: 'tool-end' }> => event.type === 'tool-end',
    )
    expect(toolEnd?.result).toContain('milo')

    expect(calls).toBe(2)
    expect(events.at(-1)).toMatchObject({ type: 'done' })

    const recalled = await memory.recall(scope, 'what is the package called?', { limit: 5 })
    expect(recalled.length).toBeGreaterThan(0)
  })
})
