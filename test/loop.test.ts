import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../src/core/agent/events.js'
import { runAgent } from '../src/core/agent/loop.js'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/core/providers/types.js'
import { ToolRegistry } from '../src/core/tools/registry.js'
import type { Tool } from '../src/core/tools/types.js'
import { TracedProvider, type TraceEvent } from '../src/core/traces.js'

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

/** A provider whose stream dies after part of an answer has already gone out. */
class DyingProvider implements Provider {
  readonly id = 'dying'

  async *stream(): AsyncGenerator<StreamEvent> {
    yield { type: 'reasoning', delta: 'thinking about it' }
    yield { type: 'text', delta: 'I was saying that ' }
    yield { type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a.txt' } }
    throw new Error('socket hang up')
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

  it('keeps what was already shown when the provider dies mid-answer', async () => {
    // A body that fails after the 200: the surface has drawn part of the answer
    // already, and the transcript has to agree with what the person read.
    const provider = new DyingProvider()
    const registry = new ToolRegistry([fakeTool])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

    await expect(async () => {
      for await (const _event of runAgent({
        provider,
        model: 'm',
        tools: registry.specs(),
        registry,
        messages,
        context: { cwd: process.cwd(), signal: new AbortController().signal },
      })) {
        // drain
      }
    }).rejects.toThrow('socket hang up')

    const assistant = messages.at(-1)!
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toContainEqual({ type: 'text', text: 'I was saying that ' })
    expect(assistant.content).toContainEqual({ type: 'reasoning', text: 'thinking about it' })
    // A call that half-arrived is dropped: without its result it is a request the
    // Anthropic wire refuses, and the turn ended in the error anyway.
    expect(assistant.content.some((part) => part.type === 'tool-call')).toBe(false)
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
    // The same effort, in the shape the Anthropic wire takes: the OpenAI wire
    // reads the level, this one reads a token budget.
    expect(provider.last?.thinkingBudget).toBe(1024)
  })

  it('carries a thought signature onto the transcript', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'reasoning', delta: 'pondering' },
        { type: 'reasoning-signature', signature: 'sig-abc' },
        { type: 'text', delta: 'ok' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const registry = new ToolRegistry([fakeTool])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

    for await (const _event of runAgent({
      provider,
      model: 'm',
      tools: [],
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal },
    })) {
      // drain
    }

    // The signature stays with the thought, which is what lets the Anthropic
    // wire replay it on the next request.
    const assistant = messages.find((message) => message.role === 'assistant')
    expect(assistant?.content[0]).toEqual({
      type: 'reasoning',
      text: 'pondering',
      signature: 'sig-abc',
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

  it('asks for a closing answer when the steps run out, instead of ending on the error alone', async () => {
    const provider = new ScriptedProvider([
      [{ type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a' } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call', id: 'c2', name: 'fake_read', args: { path: 'b' } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'I read a and b; c is still unread.' }, { type: 'done', finishReason: 'stop' }],
    ])
    const registry = new ToolRegistry([fakeTool])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]

    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal },
      maxSteps: 2,
    })) {
      events.push(event)
    }

    // The closing request carries no tools: with nothing to call there is nothing
    // left to loop on, and the instruction rides on the system prompt so the
    // transcript is not left carrying a sentence nobody said.
    expect(provider.calls).toBe(3)
    expect(provider.last?.tools).toBeUndefined()
    expect(provider.last?.system).toContain('run out of steps')

    // What it says reaches the caller, and it is kept in the transcript.
    const streamed = events.flatMap((event) => (event.type === 'text-delta' ? [event.delta] : []))
    expect(streamed.join('')).toBe('I read a and b; c is still unread.')
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' })

    // The ceiling is still reported: a turn cut short is not a turn that finished.
    const last = events.at(-1) as { type: string; message?: string }
    expect(last.type).toBe('error')
    expect(last.message).toContain('answered with what it had')
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

    // The step, and then the closing request the ceiling makes — the correction is
    // part of neither, which is the contract the CLI relies on.
    expect(provider.calls).toBe(2)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
    // What is still in the array was never seen.
    expect(steering).toEqual(['one more thing'])
  })
})

describe('runAgent — concurrent reads', () => {
  /** A read tool that records how many of it run at once. */
  function reader(name: string, opts: { concurrent?: boolean }, stats: { active: number; peak: number }) {
    return {
      name,
      description: name,
      schema: z.object({ path: z.string() }),
      readOnly: true,
      ...(opts.concurrent ? { concurrent: true } : {}),
      async execute(args: { path: string }) {
        stats.active += 1
        stats.peak = Math.max(stats.peak, stats.active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        stats.active -= 1
        return { content: `${name}:${args.path}` }
      },
    } satisfies Tool<{ path: string }>
  }

  async function runBoth(tools: Tool<{ path: string }>[]) {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'read_a', args: { path: 'a' } },
        { type: 'tool-call', id: 'c2', name: 'read_b', args: { path: 'b' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }],
    ])
    const registry = new ToolRegistry(tools)
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'read both' }] }]
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
    return { events, messages }
  }

  it('overlaps a run of concurrent reads', async () => {
    const stats = { active: 0, peak: 0 }
    await runBoth([reader('read_a', { concurrent: true }, stats), reader('read_b', { concurrent: true }, stats)])
    expect(stats.peak).toBe(2)
  })

  it('keeps each start and end interleaved, in the order the model asked', async () => {
    const stats = { active: 0, peak: 0 }
    const { events } = await runBoth([
      reader('read_a', { concurrent: true }, stats),
      reader('read_b', { concurrent: true }, stats),
    ])
    const toolEvents = events
      .filter((event) => event.type === 'tool-start' || event.type === 'tool-end')
      .map((event) => `${event.type}:${event.name}`)
    expect(toolEvents).toEqual([
      'tool-start:read_a',
      'tool-end:read_a',
      'tool-start:read_b',
      'tool-end:read_b',
    ])
  })

  it('runs a read that did not opt in one at a time', async () => {
    const stats = { active: 0, peak: 0 }
    await runBoth([reader('read_a', {}, stats), reader('read_b', {}, stats)])
    expect(stats.peak).toBe(1)
  })
})

describe('runAgent — the plan', () => {
  it('turns the plan a tool returns into a todo event', async () => {
    const planTool: Tool<{ todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] }> = {
      name: 'todo',
      description: 'plan',
      schema: z.object({
        todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })),
      }),
      internal: true,
      async execute(args) {
        return { content: 'ok', todos: args.todos.map((todo) => ({ content: todo.content, status: todo.status })) }
      },
    }
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'todo', args: { todos: [{ content: 'Step', status: 'pending' }] } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }],
    ])
    const registry = new ToolRegistry([planTool])
    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      context: { cwd: process.cwd(), signal: new AbortController().signal },
    })) {
      events.push(event)
    }
    expect(events.find((event) => event.type === 'todo')).toEqual({
      type: 'todo',
      items: [{ content: 'Step', status: 'pending' }],
    })
  })
})

describe('runAgent — stopping', () => {
  it('stops between tool calls once the turn is aborted', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a' } },
        { type: 'tool-call', id: 'c2', name: 'fake_read', args: { path: 'b' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ])
    const registry = new ToolRegistry([fakeTool])
    const controller = new AbortController()
    const events: AgentEvent[] = []

    await expect(async () => {
      for await (const event of runAgent({
        provider,
        model: 'm',
        tools: registry.specs(),
        registry,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'read a and b' }] }],
        context: { cwd: process.cwd(), signal: controller.signal },
      })) {
        events.push(event)
        // The person stops the turn while the first call's result is coming back.
        if (event.type === 'tool-end') controller.abort()
      }
    }).rejects.toThrow('the turn was stopped')

    // The call already in flight ran and was reported; the next one never started.
    expect(events.filter((event) => event.type === 'tool-end')).toHaveLength(1)
    expect(events.some((event) => event.type === 'tool-start' && event.id === 'c2')).toBe(false)
  })
})

describe('the execution log along a turn', () => {
  it('times every request and every tool call, naming the surface and the session', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text', delta: 'reading…' },
        { type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a.txt' } },
        { type: 'usage', inputTokens: 7, outputTokens: 2 },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text', delta: 'done' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const registry = new ToolRegistry([fakeTool])
    const seen: TraceEvent[] = []
    const writer = { record: (entry: TraceEvent) => seen.push(entry) }
    // The wrapper is what the runtime builds around the real provider; the loop
    // stamps the tag it reads and times the tool calls itself.
    const traced = new TracedProvider(provider, writer)

    for await (const _ of runAgent({
      provider: traced,
      model: 'test-model',
      tools: registry.specs(),
      registry,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.txt' }] }],
      context: { cwd: process.cwd(), signal: new AbortController().signal },
      trace: { traces: writer, surface: 'cli', session: 'calm-otter-7' },
    })) {
      void _
    }

    const models = seen.filter((event) => event.event === 'model.request')
    expect(models).toHaveLength(2)
    expect(models[0]).toMatchObject({
      purpose: 'chat',
      surface: 'cli',
      session: 'calm-otter-7',
      model: 'test-model',
      provider: 'scripted',
      inputTokens: 7,
      outputTokens: 2,
      finish: 'tool_calls',
    })
    expect(seen.find((event) => event.event === 'tool.call')).toMatchObject({
      tool: 'fake_read',
      ok: true,
      purpose: 'chat',
      surface: 'cli',
      session: 'calm-otter-7',
    })
  })
})

