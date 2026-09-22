import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMemory } from '../src/core/memory/local'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/core/providers/types'
import { Session } from '../src/core/session'
import { estimateTokens, planCut, summarize } from '../src/core/sessions/compact'
import { MemorySessionStore } from '../src/core/sessions/memory-store'
import { createToolRegistry } from '../src/core/tools'

const text = (role: 'user' | 'assistant' | 'tool', value: string): Message => ({
  role,
  content: [{ type: 'text', text: value }],
})

/** An assistant tool call, its result, and the follow-up — one indivisible block. */
function toolTurn(id: string): Message[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool-call', id, name: 'read_file', args: { path: 'x' } },
      ],
    },
    { role: 'tool', content: [{ type: 'tool-result', id, name: 'read_file', content: 'file body' }] },
    text('assistant', 'found it'),
  ]
}

class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  readonly systems: string[] = []
  failing = false

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.systems.push(req.system ?? '')
    if (!req.tools) {
      if (this.failing) throw new Error('summary failed')
      yield { type: 'text', delta: 'OLD_TURNS_SUMMARY' }
      yield { type: 'done', finishReason: 'stop' }
      return
    }
    yield { type: 'text', delta: 'answer' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

async function compactingSession(seed: Message[], options: { failing?: boolean } = {}) {
  const provider = new ScriptedProvider()
  provider.failing = options.failing ?? false
  const store = new MemorySessionStore()
  const record = await store.create()
  record.messages = seed

  const session = new Session({
    scope: { gateway: 'cli', conversationId: 'c' },
    provider,
    model: 'm',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new FileMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
    cwd: process.cwd(),
    record,
    store,
    sessions: { maxInputTokens: 40, keepTurns: 1, compaction: true },
  })

  const events = []
  for await (const event of session.send('brand new question')) events.push(event)
  return { provider, session, events }
}

const longSeed = (): Message[] => [
  text('user', `first ${'x'.repeat(200)}`),
  ...toolTurn('call_1'),
  text('user', `second ${'y'.repeat(200)}`),
  text('assistant', `reply ${'z'.repeat(200)}`),
  text('user', 'third'),
  text('assistant', 'third reply'),
]

describe('estimateTokens', () => {
  it('grows with the size of the transcript', () => {
    expect(estimateTokens([])).toBe(0)
    expect(estimateTokens([text('user', 'a'.repeat(400))])).toBeGreaterThan(90)
  })

  it('counts tool calls and results', () => {
    const withTools = estimateTokens([text('user', 'hi'), ...toolTurn('call_1')])
    expect(withTools).toBeGreaterThan(estimateTokens([text('user', 'hi')]))
  })
})

describe('planCut', () => {
  it('cuts on a user turn boundary', () => {
    const messages = longSeed()
    const cut = planCut(messages, 1)

    expect(messages[cut]!.role).toBe('user')
    expect(messages.slice(cut)).toEqual([text('user', 'third'), text('assistant', 'third reply')])
  })

  it('never splits a tool call from its result', () => {
    const messages = longSeed()
    const dropped = messages.slice(0, planCut(messages, 1))

    const last = dropped[dropped.length - 1]!
    expect(last.content.some((part) => part.type === 'tool-call')).toBe(false)
    // The tool call and its result are on the same side of the cut.
    const droppedHasCall = dropped.some((m) => m.content.some((p) => p.type === 'tool-call'))
    const droppedHasResult = dropped.some((m) => m.content.some((p) => p.type === 'tool-result'))
    expect(droppedHasCall).toBe(droppedHasResult)
    expect(droppedHasCall).toBe(true)
  })

  it('has nothing to cut when there are few turns', () => {
    expect(planCut([text('user', 'a'), text('assistant', 'b')], 5)).toBe(0)
    expect(planCut(longSeed(), 0)).toBe(0)
  })
})

describe('summarize', () => {
  it('returns null when the provider fails', async () => {
    const provider = new ScriptedProvider()
    provider.failing = true
    const result = await summarize({ provider, model: 'm', dropped: longSeed() })
    expect(result).toBeNull()
  })

  it('returns null for an empty transcript', async () => {
    const provider = new ScriptedProvider()
    expect(await summarize({ provider, model: 'm', dropped: [] })).toBeNull()
  })
})

describe('Session compaction', () => {
  it('summarizes the dropped turns and keeps them out of the transcript', async () => {
    const { provider, session } = await compactingSession(longSeed())

    expect(provider.systems.some((system) => system.includes('compress a conversation'))).toBe(true)

    const system = provider.systems.at(-1)!
    expect(system).toContain('## Earlier in this conversation')
    expect(system).toContain('OLD_TURNS_SUMMARY')

    // The kept turn starts on a user message, so no tool pair was split.
    expect(session.messages[0]!.role).toBe('user')
    expect(session.messages.length).toBeLessThan(longSeed().length)

    const stats = session.stats()
    expect(stats.compacted).toBe(true)
    expect(stats.droppedTokens).toBeGreaterThan(0)
  })

  it('still fits the request when the summary call fails', async () => {
    const { provider, session, events } = await compactingSession(longSeed(), { failing: true })

    const system = provider.systems.at(-1)!
    expect(system).not.toContain('## Earlier in this conversation')

    expect(session.messages[0]!.role).toBe('user')
    expect(session.messages.length).toBeLessThan(longSeed().length)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('does nothing when compaction is off', async () => {
    const store = new MemorySessionStore()
    const record = await store.create()
    record.messages = longSeed()
    const provider = new ScriptedProvider()

    const session = new Session({
      scope: { gateway: 'cli', conversationId: 'c' },
      provider,
      model: 'm',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new FileMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
      cwd: process.cwd(),
      record,
      store,
      sessions: { maxInputTokens: 40, keepTurns: 1, compaction: false },
    })

    for await (const _event of session.send('another one')) {
      // drain
    }

    expect(provider.systems.some((system) => system.includes('compress a conversation'))).toBe(false)
    expect(session.stats().compacted).toBe(false)
  })

  it('counts the system prompt against the budget, not just the transcript', async () => {
    // A transcript of almost nothing, and a budget far above it — but the tool
    // list and environment that ride along with every request do not fit, which
    // is the part the old count ignored.
    const seed = [text('user', 'first'), text('assistant', 'ok'), text('user', 'second')]
    const store = new MemorySessionStore()
    const record = await store.create()
    record.messages = seed
    const provider = new ScriptedProvider()

    const session = new Session({
      scope: { gateway: 'cli', conversationId: 'c' },
      provider,
      model: 'm',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new FileMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
      cwd: process.cwd(),
      record,
      store,
      sessions: { maxInputTokens: 500, keepTurns: 1, compaction: true },
    })

    for await (const _event of session.send('another one')) {
      // drain
    }

    expect(estimateTokens(seed)).toBeLessThan(100)
    expect(provider.systems.some((system) => system.includes('compress a conversation'))).toBe(true)
  })
})
