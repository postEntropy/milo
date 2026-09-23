import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../src/core/agent/events.js'
import { runAgent } from '../src/core/agent/loop.js'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/core/providers/types.js'
import { ToolRegistry } from '../src/core/tools/registry.js'
import type { Tool } from '../src/core/tools/types.js'

class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  calls = 0

  constructor(private readonly scripts: StreamEvent[][]) {}

  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    const script = this.scripts[this.calls] ?? [{ type: 'done', finishReason: 'stop' }]
    this.calls += 1
    for (const event of script) yield event
  }
}

const fakeTool: Tool<{ path: string }> = {
  name: 'fake_read',
  description: 'fake read',
  schema: z.object({ path: z.string() }),
  async execute(args) {
    return { content: `FILE:${args.path}` }
  },
}

describe('runAgent', () => {
  it('executes a tool call and continues the loop until a final answer', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'reasoning', delta: 'let me think' },
        { type: 'text', delta: 'reading…' },
        { type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a.txt' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text', delta: 'done' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const registry = new ToolRegistry([fakeTool])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }]

    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal },
    })) {
      events.push(event)
    }

    expect(provider.calls).toBe(2)
    expect(events.find((event) => event.type === 'reasoning-delta')).toMatchObject({
      delta: 'let me think',
    })
    expect(events.find((event) => event.type === 'tool-start')).toMatchObject({ name: 'fake_read' })
    expect(events.find((event) => event.type === 'tool-end')).toMatchObject({
      name: 'fake_read',
      result: 'FILE:a.txt',
      isError: false,
    })
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' })

    const assistant = messages.find((message) => message.role === 'assistant')
    expect(assistant?.content.some((part) => part.type === 'tool-call')).toBe(true)

    const toolMessage = messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content[0]).toMatchObject({
      type: 'tool-result',
      content: 'FILE:a.txt',
    })
  })

  it('stops after maxSteps when the model keeps calling tools', async () => {
    const provider = new ScriptedProvider([
      [{ type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a' } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call', id: 'c2', name: 'fake_read', args: { path: 'b' } }, { type: 'done', finishReason: 'tool_calls' }],
    ])
    const registry = new ToolRegistry([fakeTool])
    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      context: { cwd: process.cwd(), signal: new AbortController().signal },
      maxSteps: 2,
    })) {
      events.push(event)
    }
    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })
})
