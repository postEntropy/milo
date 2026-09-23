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
  /** The request the provider was last handed. */
  last?: ChatRequest

  constructor(private readonly scripts: StreamEvent[][]) {}

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.last = req
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

  it('hands the reasoning effort to the provider', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text', delta: 'ok' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const registry = new ToolRegistry([fakeTool])

    for await (const _event of runAgent({
      provider,
      model: 'm',
      tools: [],
      registry,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      context: { cwd: process.cwd(), signal: new AbortController().signal },
      reasoningEffort: 'low',
    })) {
      // drain
    }

    expect(provider.last?.reasoningEffort).toBe('low')
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

describe('runAgent — steering', () => {
  /** Drives a turn and hands `steer` in while the first answer is streaming. */
  async function runWithSteer(steer: string, extra: { maxSteps?: number } = {}) {
    const provider = new ScriptedProvider([
      [
        { type: 'text', delta: 'let me look at a.txt' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text', delta: 'looking at b.txt' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const registry = new ToolRegistry([fakeTool])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }]
    const steering: string[] = []

    const events: AgentEvent[] = []
    let handedIn = false
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal },
      steering,
      maxSteps: extra.maxSteps,
    })) {
      events.push(event)
      // The user types while the answer is still coming in.
      if (event.type === 'text-delta' && !handedIn) {
        handedIn = true
        steering.push(steer)
      }
    }

    return { provider, messages, steering, events }
  }

  it('answers a message sent mid-turn instead of ending the turn', async () => {
    const { provider, events, steering } = await runWithSteer('no, read b.txt')

    // A second model call, not a second turn.
    expect(provider.calls).toBe(2)
    expect(events.filter((event) => event.type === 'steer')).toEqual([
      { type: 'steer', text: 'no, read b.txt' },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    // Nothing is left over for the caller to run again.
    expect(steering).toEqual([])
  })

  it('puts the correction in the transcript after the answer it interrupted', async () => {
    const { messages } = await runWithSteer('no, read b.txt')

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'no, read b.txt' }],
    })
  })

  it('leaves a message it ran out of steps to answer, for the caller to run', async () => {
    const { provider, events, steering } = await runWithSteer('one more thing', { maxSteps: 1 })

    expect(provider.calls).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    // The contract the CLI relies on: what is still in the array was never seen.
    expect(steering).toEqual(['one more thing'])
  })
})
