import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import type { ChatRequest, Message, Provider, ReasoningEffort, StreamEvent } from '../src/core/providers/types.js'
import { Session } from '../src/core/session.js'
import { digest, estimateTokens, planCut, summarize } from '../src/core/sessions/compact.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { createToolRegistry } from '../src/core/tools/index.js'

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
  /** The effort each summary call asked for, in order. */
  readonly efforts: (ReasoningEffort | undefined)[] = []
  failing = false
  /** Refuses any request that names an effort, the way a provider without the field would. */
  rejectsEffort = false

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.systems.push(req.system ?? '')
    if (!req.tools) {
      this.efforts.push(req.reasoningEffort)
      if (this.failing) throw new Error('summary failed')
      if (this.rejectsEffort && req.reasoningEffort) throw new Error('unknown field: reasoning_effort')
      yield { type: 'text', delta: 'OLD_TURNS_SUMMARY' }
      yield { type: 'done', finishReason: 'stop' }
      return
    }
    yield { type: 'text', delta: 'answer' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

async function compactingSession(
  seed: Message[],
  options: {
    failing?: boolean
    contextWindow?: number
    lookup?: (model: string) => Promise<number | undefined>
  } = {},
) {
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
    memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
    cwd: process.cwd(),
    record,
    store,
    sessions: {
      compactAt: 0.7,
      maxInputTokens: 40,
      keepTurns: 1,
      compaction: true,
      contextWindow: options.contextWindow,
    },
    lookupContextWindow: options.lookup,
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

/** A session with a seed and a ceiling nothing reaches: `/compact` on demand. */
async function manualSession(
  seed: Message[],
  overrides: { keepTurns?: number; compaction?: boolean } = {},
) {
  const provider = new ScriptedProvider()
  const store = new MemorySessionStore()
  const record = await store.create()
  record.messages = seed

  const session = new Session({
    scope: { gateway: 'cli', conversationId: 'c' },
    provider,
    model: 'm',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
    cwd: process.cwd(),
    record,
    store,
    sessions: {
      compactAt: 0.7,
      maxInputTokens: 100_000,
      keepTurns: overrides.keepTurns ?? 1,
      compaction: overrides.compaction ?? true,
    },
  })
  return { provider, session, store, record }
}

describe('session.compact', () => {
  it('folds the oldest turns now, without waiting for the budget', async () => {
    const { provider, session } = await manualSession(longSeed())

    const result = await session.compact()
    expect(result.reason).toBeUndefined()
    expect(result.summarized).toBe(true)
    // The first turn and the tool turn that followed it: the cut lands on a user
    // turn, so a tool call never travels without its result.
    expect(result.folded).toBe(2)
    expect(result.tokens).toBeGreaterThan(0)

    // In play, not just counted: the next request carries the summary and no
    // longer carries the turns it replaced.
    await drain(session)
    const system = provider.systems.at(-1)!
    expect(system).toContain('OLD_TURNS_SUMMARY')
    expect(system).not.toContain('first xxx')
  })

  it('says there was nothing to fold rather than claiming a compaction', async () => {
    const { session } = await manualSession([text('user', 'only'), text('assistant', 'turn')])

    const result = await session.compact()
    expect(result.folded).toBe(0)
    expect(result.summarized).toBe(false)
    expect(result.reason).toContain('nothing is old enough')
  })

  it('writes the fold down, so a restart does not take it back', async () => {
    const { session, store, record } = await manualSession(longSeed())

    await session.compact()
    const saved = await store.load(record.id)
    expect(saved?.droppedTokens).toBeGreaterThan(0)
    expect(saved?.summary).toContain('OLD_TURNS_SUMMARY')
  })

  it('says compaction is off instead of folding anyway', async () => {
    const { session } = await manualSession(longSeed(), { compaction: false })

    const result = await session.compact()
    expect(result.folded).toBe(0)
    expect(result.reason).toContain('compaction is off')
  })

  it('keeps the turns it folded when the summary call fails', async () => {
    const { provider, session } = await manualSession(longSeed())
    provider.failing = true

    const result = await session.compact()
    // The turns go anyway — a request that fits beats one the provider rejects —
    // and the result says no summary was written in their place.
    expect(result.folded).toBe(2)
    expect(result.summarized).toBe(false)
  })
})

/** Runs a turn and throws the events away, for a session that must answer again. */
async function drain(session: Session): Promise<void> {
  for await (const _event of session.send('next')) {
    // Nothing to look at: the assertion is on what the provider was sent.
  }
}

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

  it('asks the mechanical call for a low effort', async () => {
    // Nobody reads a summary's reasoning; it is only seconds added to a turn.
    const provider = new ScriptedProvider()
    await summarize({ provider, model: 'm', dropped: longSeed() })

    expect(provider.efforts).toEqual(['low'])
  })

  it('asks again without the hint when the provider does not know the field', async () => {
    const provider = new ScriptedProvider()
    provider.rejectsEffort = true

    const result = await summarize({ provider, model: 'm', dropped: longSeed() })

    // The summary is worth a second try: losing every one of them to a field the
    // provider has never heard of is the worse failure.
    expect(result).toBe('OLD_TURNS_SUMMARY')
    expect(provider.efforts).toEqual(['low', undefined])
  })
})

describe('digest', () => {
  it('asks for bullets and returns the recap', async () => {
    const provider = new ScriptedProvider()
    const result = await digest({ provider, model: 'm', messages: longSeed() })

    expect(result).toBe('OLD_TURNS_SUMMARY')
    expect(provider.systems.at(-1)).toContain('short recap')
  })

  it('returns null for an empty transcript', async () => {
    const provider = new ScriptedProvider()
    expect(await digest({ provider, model: 'm', messages: [] })).toBeNull()
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

  it('reports what the summary cost, before the turn produces anything', async () => {
    const { events } = await compactingSession(longSeed())

    const at = events.findIndex((event) => event.type === 'compacted')
    expect(at).toBeGreaterThanOrEqual(0)
    // It has to arrive before the turn's own output: a surface only has the
    // number in time to name the wait if the compaction is reported first.
    expect(at).toBeLessThan(events.findIndex((event) => event.type === 'done'))
    expect(events[at]).toMatchObject({ type: 'compacted' })
    expect((events[at] as { ms: number }).ms).toBeGreaterThanOrEqual(0)
  })

  it('says nothing when there was nothing to compact', async () => {
    // Already over budget, but there is no user turn to cut on — so no summary
    // call is made and there is no cost to report.
    const { events } = await compactingSession([])

    expect(events.some((event) => event.type === 'compacted')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('measures against the model window, not the fallback, when one is known', async () => {
    // A 100k window at 70% is 70k: this transcript is nowhere near it, where the
    // 40-token fallback would have summarized it. The fallback is what a fixed
    // 12000 against a million-token model was doing every turn.
    const { provider, session, events } = await compactingSession(longSeed(), {
      lookup: async () => 100_000,
    })

    expect(events.some((event) => event.type === 'compacted')).toBe(false)
    expect(provider.systems.every((system) => !system.includes('compress a conversation'))).toBe(true)
    expect(session.stats().maxInputTokens).toBe(70_000)
  })

  it('takes a configured window over what the lookup says', async () => {
    const { session } = await compactingSession(longSeed(), {
      contextWindow: 2000,
      lookup: async () => 1_000_000,
    })

    expect(session.stats().maxInputTokens).toBe(1400)
  })

  it('reports the fallback when nothing knows the window', async () => {
    const { session } = await compactingSession(longSeed(), { lookup: async () => undefined })

    expect(session.stats().maxInputTokens).toBe(40)
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
      memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
      cwd: process.cwd(),
      record,
      store,
      sessions: { compactAt: 0.7, maxInputTokens: 40, keepTurns: 1, compaction: false },
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
      memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
      cwd: process.cwd(),
      record,
      store,
      sessions: { compactAt: 0.7, maxInputTokens: 500, keepTurns: 1, compaction: true },
    })

    for await (const _event of session.send('another one')) {
      // drain
    }

    expect(estimateTokens(seed)).toBeLessThan(100)
    expect(provider.systems.some((system) => system.includes('compress a conversation'))).toBe(true)
  })
})
