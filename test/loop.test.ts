import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { AgentEvent } from '../src/core/agent/events.js'
import { runAgent } from '../src/core/agent/loop.js'
import { finalThoughtMs, initialTurnWaitState, reduceTurnWaitState } from '../src/core/agent/turn-state.js'
import { AnthropicProvider } from '../src/core/providers/anthropic.js'
import { ResponsesProvider } from '../src/core/providers/responses.js'
import type {
  ChatRequest,
  Message,
  Provider,
  StreamEvent,
  ToolCallPart,
  ToolResultPart,
} from '../src/core/providers/types.js'
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

/**
 * A provider whose stream dies once before any of the answer has gone out — the
 * reasoning has started, but no word of the answer and no tool call have — which
 * is the one failure a step is asked again for.
 */
class FlakyProvider implements Provider {
  readonly id = 'flaky'
  calls = 0

  async *stream(): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'reasoning', delta: 'thinking it over' }
      throw new Error('terminated (read ECONNRESET)')
    }
    yield { type: 'text', delta: 'the answer' }
    yield { type: 'done', finishReason: 'stop' }
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

  it('says a step that may have changed something, and stays quiet for one that only read', async () => {
    const peek: Tool<{ path: string }> = {
      name: 'fake_peek',
      description: 'fake peek',
      schema: z.object({ path: z.string() }),
      readOnly: true,
      async execute(args) {
        return { content: `FILE:${args.path}` }
      },
    }
    const write: Tool<{ path: string }> = {
      name: 'fake_write',
      description: 'fake write',
      schema: z.object({ path: z.string() }),
      async execute(args) {
        return { content: `WROTE:${args.path}` }
      },
    }
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'fake_peek', args: { path: 'a.txt' } },
        { type: 'tool-call', id: 'c2', name: 'fake_write', args: { path: 'b.txt' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text', delta: 'both done' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])
    const registry = new ToolRegistry([peek, write])
    const effects: { tool: string; args: unknown }[] = []

    for await (const _event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read a, write b' }] }],
      context: { cwd: process.cwd(), signal: new AbortController().signal },
      onSideEffect: (effect) => { effects.push(effect) },
    })) {
      // drain
    }

    // Two steps ran and one of them is news: a surface watching a folder has nothing new to
    // read after a peek, and would pay for a tree and a diff to find that out.
    expect(effects).toEqual([{ tool: 'fake_write', args: { path: 'b.txt' } }])
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

  it('asks the model again when the stream dies before any of the answer has gone out', async () => {
    // A reset socket after the 200, with only the reasoning streamed: nothing of
    // this step is anywhere yet — the transcript is not written until the step
    // ends — so a second try is worth the wait.
    const provider = new FlakyProvider()
    const registry = new ToolRegistry([fakeTool])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: [],
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal },
    })) {
      events.push(event)
    }

    expect(provider.calls).toBe(2)
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' })
    // The transcript holds the answer, not the scratch the dead first try left behind.
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'the answer' }],
    })
  })

  it('gives up after a few tries when the stream keeps dying before the answer', async () => {
    class AlwaysDyingProvider implements Provider {
      readonly id = 'always-dying'
      calls = 0

      async *stream(): AsyncGenerator<StreamEvent> {
        this.calls += 1
        yield { type: 'reasoning', delta: 'thinking' }
        throw new Error('terminated (read ECONNRESET)')
      }
    }
    const provider = new AlwaysDyingProvider()
    const registry = new ToolRegistry([fakeTool])

    await expect(async () => {
      for await (const _event of runAgent({
        provider,
        model: 'm',
        tools: [],
        registry,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        context: { cwd: process.cwd(), signal: new AbortController().signal },
      })) {
        // drain
      }
    }).rejects.toThrow('terminated (read ECONNRESET)')

    // The first try and the two retries it is allowed, and no more.
    expect(provider.calls).toBe(3)
  })

  it('does not ask again once the turn has been stopped', async () => {
    class StoppedProvider implements Provider {
      readonly id = 'stopped'
      calls = 0

      async *stream(): AsyncGenerator<StreamEvent> {
        this.calls += 1
        yield { type: 'reasoning', delta: 'thinking' }
        const error = new Error('This operation was aborted.')
        error.name = 'AbortError'
        throw error
      }
    }
    const provider = new StoppedProvider()
    const registry = new ToolRegistry([fakeTool])

    await expect(async () => {
      for await (const _event of runAgent({
        provider,
        model: 'm',
        tools: [],
        registry,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        context: { cwd: process.cwd(), signal: new AbortController().signal },
      })) {
        // drain
      }
    }).rejects.toThrow('This operation was aborted.')

    expect(provider.calls).toBe(1)
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

  it('leaves no empty assistant message when a step produces nothing', async () => {
    const provider = new ScriptedProvider([[{ type: 'done', finishReason: 'stop' }]])
    const registry = new ToolRegistry([fakeTool])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: [],
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal },
    })) {
      events.push(event)
    }

    expect(events.at(-1)).toMatchObject({ type: 'done' })
    // Nothing was said and nothing was called: there is no assistant turn to store,
    // and an empty one is a message every later request has to carry.
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
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

  it('drops a tool call the model wrote as text when the steps run out', async () => {
    const leaked = [
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="shell_command">',
      '<｜｜DSML｜｜ parameter name="command" string="true">ls</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n')
    const provider = new ScriptedProvider([
      [{ type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a' } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call', id: 'c2', name: 'fake_read', args: { path: 'b' } }, { type: 'done', finishReason: 'tool_calls' }],
      // Split across deltas, the way a written-out call arrives.
      [
        { type: 'text', delta: leaked.slice(0, 24) },
        { type: 'text', delta: leaked.slice(24) },
        { type: 'done', finishReason: 'stop' },
      ],
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

    // Nothing readable was said, so nothing readable is kept or shown — and the
    // turn says so instead of passing a tool call off as an answer.
    const streamed = events.flatMap((event) => (event.type === 'text-delta' ? [event.delta] : []))
    expect(streamed.join('')).toBe('')
    // The two steps left their tool calls behind; what must not be there is a
    // closing answer made of the call the model could not make.
    const spoken = messages.flatMap((message) =>
      message.role === 'assistant' ? message.content.filter((part) => part.type === 'text') : [],
    )
    expect(spoken).toHaveLength(0)
    const last = events.at(-1) as { type: string; message?: string }
    expect(last.type).toBe('error')
    expect(last.message).toContain('without a final answer')
  })

  it('keeps the prose a model wrote before a call it could not make', async () => {
    const leaked = [
      'I fixed the glyph.',
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="shell_command">',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n')
    const provider = new ScriptedProvider([
      [{ type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a' } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call', id: 'c2', name: 'fake_read', args: { path: 'b' } }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: leaked }, { type: 'done', finishReason: 'stop' }],
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

    const streamed = events.flatMap((event) => (event.type === 'text-delta' ? [event.delta] : []))
    expect(streamed.join('')).toBe('I fixed the glyph.')
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'I fixed the glyph.' }],
    })
    const last = events.at(-1) as { type: string; message?: string }
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

  it('answers the calls a stop never reached, so the next request is one the wires accept', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'fake_read', args: { path: 'a' } },
        { type: 'tool-call', id: 'c2', name: 'fake_read', args: { path: 'b' } },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ])
    const registry = new ToolRegistry([fakeTool])
    const controller = new AbortController()
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'read a and b' }] }]

    await expect(async () => {
      for await (const event of runAgent({
        provider,
        model: 'm',
        tools: registry.specs(),
        registry,
        messages,
        context: { cwd: process.cwd(), signal: controller.signal },
      })) {
        if (event.type === 'tool-end') controller.abort()
      }
    }).rejects.toThrow('the turn was stopped')

    // An assistant turn whose calls are not all answered is one every wire after
    // it refuses, so the calls that never ran are answered as stopped: each one
    // the model made names a result in the transcript.
    const parts = messages.flatMap((message) => message.content)
    const called = parts.filter((part): part is ToolCallPart => part.type === 'tool-call').map((part) => part.id)
    const answered = parts
      .filter((part): part is ToolResultPart => part.type === 'tool-result')
      .map((part) => part.id)
    expect(called).toEqual(['c1', 'c2'])
    expect(answered).toEqual(['c1', 'c2'])
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
      trace: { traces: writer, surface: 'cli', session: 'calm-otter-7', turn: 'turn-1' },
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
      turn: 'turn-1',
      callId: 'c1',
      input: { path: 'a.txt' },
      output: expect.objectContaining({ content: expect.any(String) }),
      ok: true,
      purpose: 'chat',
      surface: 'cli',
      session: 'calm-otter-7',
    })
  })
})

describe('runAgent — concurrent tool error & abort pairing', () => {
  it('turns an unexpected non-abort failure in a concurrent run into an error tool-result', async () => {
    const firstRead: Tool = {
      name: 'boom_read',
      description: 'fails in policy decide',
      schema: z.object({}),
      readOnly: true,
      concurrent: true,
      async execute() {
        return { content: 'unreachable' }
      },
    }
    const okRead: Tool = {
      name: 'ok_read',
      description: 'succeeds',
      schema: z.object({}),
      readOnly: true,
      concurrent: true,
      async execute() {
        return { content: 'fine' }
      },
    }
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'boom_read', args: {} },
        { type: 'tool-call', id: 'c2', name: 'ok_read', args: {} },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text', delta: 'recovered' }, { type: 'done', finishReason: 'stop' }],
    ])
    const registry = new ToolRegistry([firstRead, okRead])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]

    const events: AgentEvent[] = []
    for await (const event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal },
      permission: {
        policy: {
          mode: 'ask',
          setMode() {},
          update() {},
          decide(tool) {
            if (tool.name === 'boom_read') throw new Error('policy exploded')
            return 'allow'
          },
        },
      },
    })) {
      events.push(event)
    }

    const parts = messages.flatMap((message) => message.content)
    const called = parts.filter((part): part is ToolCallPart => part.type === 'tool-call').map((part) => part.id)
    const answered = parts.filter((part): part is ToolResultPart => part.type === 'tool-result').map((part) => part.id)
    expect(called).toEqual(['c1', 'c2'])
    expect(answered).toEqual(['c1', 'c2'])
    expect(events.find((event) => event.type === 'tool-end' && event.id === 'c1')).toMatchObject({
      isError: true,
      result: 'Tool "boom_read" failed: policy exploded',
    })
  })

  it('fills stopped tool-results when aborted mid-concurrent run', async () => {
    const controller = new AbortController()
    const abortingRead: Tool = {
      name: 'aborting_read',
      description: 'aborts via policy',
      schema: z.object({}),
      readOnly: true,
      concurrent: true,
      async execute() {
        return { content: 'late' }
      },
    }
    const slowRead: Tool = {
      name: 'slow_read',
      description: 'slow',
      schema: z.object({}),
      readOnly: true,
      concurrent: true,
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { content: 'late' }
      },
    }
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: 'aborting_read', args: {} },
        { type: 'tool-call', id: 'c2', name: 'slow_read', args: {} },
        { type: 'done', finishReason: 'tool_calls' },
      ],
    ])
    const registry = new ToolRegistry([abortingRead, slowRead])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]

    await expect(async () => {
      for await (const _event of runAgent({
        provider,
        model: 'm',
        tools: registry.specs(),
        registry,
        messages,
        context: { cwd: process.cwd(), signal: controller.signal },
        permission: {
          policy: {
            mode: 'ask',
            setMode() {},
            update() {},
            decide(tool) {
              if (tool.name === 'aborting_read') {
                controller.abort()
                throw new Error('aborted')
              }
              return 'allow'
            },
          },
        },
      })) { /* drain */ }
    }).rejects.toThrow('aborted')

    const parts = messages.flatMap((message) => message.content)
    const called = parts.filter((part): part is ToolCallPart => part.type === 'tool-call').map((part) => part.id)
    const answered = parts.filter((part): part is ToolResultPart => part.type === 'tool-result').map((part) => part.id)
    expect(called).toEqual(['c1', 'c2'])
    expect(answered).toEqual(['c1', 'c2'])
  })

  it('emits response-waiting per call and omits client-measured duration unless the provider gives explicit durationMs', async () => {
    vi.useFakeTimers()
    try {
      let step = 0
      const provider: Provider = {
        id: 'timed',
        async *stream(): AsyncGenerator<StreamEvent> {
          if (step === 0) {
            step += 1
            await new Promise((resolve) => setTimeout(resolve, 2000))
            yield { type: 'reasoning-start' }
            yield { type: 'reasoning', delta: 'step 1' }
            await new Promise((resolve) => setTimeout(resolve, 1200))
            yield { type: 'reasoning-end' }
            yield { type: 'tool-call', id: 'c1', name: 'slow_tool', args: {} }
            yield { type: 'done', finishReason: 'tool_calls' }
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 1500))
          yield { type: 'text', delta: 'all done' }
          yield { type: 'done', finishReason: 'stop' }
        },
      }
      const registry = new ToolRegistry()
      registry.register({
        name: 'slow_tool',
        description: 'waits 3s',
        schema: z.object({}),
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 3000))
          return { content: 'ok' }
        },
      })
      const events: AgentEvent[] = []
      const driving = (async () => {
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
      })()
      await vi.advanceTimersByTimeAsync(2000 + 1200 + 3000 + 1500)
      await driving

      expect(events.filter((e) => e.type === 'response-waiting')).toHaveLength(2)
      const reasoningEnd = events.find((e): e is Extract<AgentEvent, { type: 'reasoning-end' }> => e.type === 'reasoning-end')
      expect(reasoningEnd).toEqual({ type: 'reasoning-end' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes active reasoning without a duration when the stream fails mid-reasoning', async () => {
    const provider: Provider = {
      id: 'failing-mid-reasoning',
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'reasoning-start' }
        yield { type: 'reasoning', delta: 'partial' }
        throw new Error('stream dropped')
      },
    }
    const registry = new ToolRegistry()
    const events: AgentEvent[] = []
    await expect(async () => {
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
    }).rejects.toThrow('stream dropped')

    const end = events.find((e): e is Extract<AgentEvent, { type: 'reasoning-end' }> => e.type === 'reasoning-end')
    expect(end).toEqual({ type: 'reasoning-end' })
  })

  it('passes Responses response.completed fallback through runAgent without starting thinking or timer, while keeping summary in transcript', async () => {
    const sse = `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          { type: 'reasoning', encrypted_content: 'enc_1', summary: [{ type: 'summary_text', text: 'post-hoc summary' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'final answer' }] },
        ],
      },
    })}\n\n`
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const provider = new ResponsesProvider({ id: 'chatgpt', baseURL: 'https://example.test', apiKey: 'k' })
      const registry = new ToolRegistry()
      const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
      const events: AgentEvent[] = []
      let state = initialTurnWaitState()

      for await (const event of runAgent({
        provider,
        model: 'm',
        tools: registry.specs(),
        registry,
        messages,
        context: { cwd: process.cwd(), signal: new AbortController().signal },
      })) {
        events.push(event)
        state = reduceTurnWaitState(state, event)
      }

      expect(events.some((e) => e.type === 'reasoning-start' || e.type === 'reasoning-end')).toBe(false)
      expect(events).toContainEqual({ type: 'reasoning-delta', delta: 'post-hoc summary', replayed: true })
      expect(finalThoughtMs(state)).toBeUndefined()
      expect(messages[1]?.content).toContainEqual(expect.objectContaining({ type: 'reasoning', text: 'post-hoc summary' }))
      expect(messages[1]?.content).toContainEqual({ type: 'text', text: 'final answer' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('streams Anthropic and Responses reasoning in runAgent with live Thinking boundaries and no client-clock duration', async () => {
    vi.useFakeTimers()
    try {
      const anthropicStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`))
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } })}\n\n`))
          await new Promise((r) => setTimeout(r, 1200))
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`))
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } })}\n\n`))
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`))
          controller.close()
        },
      })
      vi.stubGlobal('fetch', vi.fn(async () => new Response(anthropicStream, { status: 200, headers: { 'content-type': 'text/event-stream' } })))

      const anthropic = new AnthropicProvider({ id: 'anthropic', baseURL: 'https://a.test/v1', apiKey: 'k' })
      const registry = new ToolRegistry()
      const anthropicMessages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
      const aEvents: AgentEvent[] = []
      let aState = initialTurnWaitState()
      const runA = (async () => {
        for await (const e of runAgent({
          provider: anthropic,
          model: 'claude-test',
          tools: registry.specs(),
          registry,
          messages: anthropicMessages,
          context: { cwd: process.cwd(), signal: new AbortController().signal },
        })) {
          aEvents.push(e)
          aState = reduceTurnWaitState(aState, e)
        }
      })()
      await vi.advanceTimersByTimeAsync(1200)
      await runA
      expect(aEvents.map((e) => e.type)).toEqual([
        'response-waiting',
        'reasoning-start',
        'reasoning-delta',
        'reasoning-end',
        'text-delta',
        'done',
      ])
      expect(aEvents.find((e) => e.type === 'reasoning-end')).toEqual({ type: 'reasoning-end' })
      expect(finalThoughtMs(aState)).toBeUndefined()
      expect(anthropicMessages[1]?.content).toContainEqual({ type: 'reasoning', text: 'pondering' })

      const responsesStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } })}\n\n`))
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'summary' })}\n\n`))
          await new Promise((r) => setTimeout(r, 1200))
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1' } })}\n\n`))
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'done' })}\n\n`))
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`))
          controller.close()
        },
      })
      vi.stubGlobal('fetch', vi.fn(async () => new Response(responsesStream, { status: 200, headers: { 'content-type': 'text/event-stream' } })))

      const responses = new ResponsesProvider({ id: 'chatgpt', baseURL: 'https://example.test', apiKey: 'k' })
      const rEvents: AgentEvent[] = []
      const runR = (async () => {
        for await (const e of runAgent({
          provider: responses,
          model: 'm',
          tools: registry.specs(),
          registry,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
          context: { cwd: process.cwd(), signal: new AbortController().signal },
        })) rEvents.push(e)
      })()
      await vi.advanceTimersByTimeAsync(1200)
      await runR
      expect(rEvents).toContainEqual({ type: 'reasoning-start' })
      expect(rEvents.find((e) => e.type === 'reasoning-end')).toEqual({ type: 'reasoning-end' })
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('invalidates prior explicit provider duration when a subsequent retry interrupts reasoning mid-turn', async () => {
    vi.useFakeTimers()
    try {
      let stepCall = 0
      const provider: Provider = {
        id: 'retry-after-thinking',
        async *stream(): AsyncGenerator<StreamEvent> {
          stepCall += 1
          if (stepCall === 1) {
            yield { type: 'reasoning-start' }
            yield { type: 'reasoning-end', durationMs: 1500 }
            yield { type: 'tool-call', id: 'c1', name: 'noop', args: {} }
            yield { type: 'done', finishReason: 'tool_calls' }
            return
          }
          if (stepCall === 2) {
            yield { type: 'reasoning-start' }
            yield { type: 'reasoning', delta: 'half thought' }
            throw new Error('ECONNRESET')
          }
          yield { type: 'reasoning-start' }
          yield { type: 'reasoning-end', durationMs: 1200 }
          yield { type: 'text', delta: 'recovered' }
          yield { type: 'done', finishReason: 'stop' }
        },
      }
      const registry = new ToolRegistry()
      registry.register({
        name: 'noop',
        description: 'noop',
        schema: z.object({}),
        async execute() { return { content: 'ok' } },
      })

      let state = initialTurnWaitState()
      const driving = (async () => {
        for await (const event of runAgent({
          provider,
          model: 'm',
          tools: registry.specs(),
          registry,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
          context: { cwd: process.cwd(), signal: new AbortController().signal },
        })) {
          state = reduceTurnWaitState(state, event)
        }
      })()
      await vi.advanceTimersByTimeAsync(2500)
      await driving

      expect(state.hasUnobservedReasoning).toBe(true)
      expect(finalThoughtMs(state)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

