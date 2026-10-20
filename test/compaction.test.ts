import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import type { ChatRequest, Message, Provider, ReasoningEffort, StreamEvent } from '../src/core/providers/types.js'
import { Session } from '../src/core/session.js'
import {
  cleanTitle,
  contextBudget,
  digest,
  estimateText,
  estimateTokens,
  estimateTools,
  generateTitle,
  planCut,
  planCutUnderBudget,
  summarize,
} from '../src/core/sessions/compact.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { DEFAULT_SESSIONS } from '../src/core/config/schema.js'
import { createToolRegistry, ToolRegistry } from '../src/core/tools/index.js'

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
  /** What the execution log would call each call, in order. */
  readonly purposes: string[] = []
  /** The words each call was handed, in order. */
  readonly prompts: string[] = []
  failing = false
  /** Refuses any request that names an effort, the way a provider without the field would. */
  rejectsEffort = false
  /** Never answers: waits for the caller's budget to cut it off, the way a slow provider does. */
  hanging = false

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.systems.push(req.system ?? '')
    this.purposes.push(req.trace?.purpose ?? '')
    this.prompts.push(req.messages.map((message) => message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ')).join('\n'))
    if (!req.tools) {
      this.efforts.push(req.reasoningEffort)
      if (this.hanging) {
        await new Promise<void>((resolve) =>
          req.signal?.addEventListener('abort', () => resolve(), { once: true }),
        )
        throw new Error('This operation was aborted')
      }
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
    maxInputTokens?: number
    keepTurns?: number
    /** The catalog the turn is sent with; the full one unless a test says otherwise. */
    registry?: ToolRegistry
  } = {},
) {
  const provider = new ScriptedProvider()
  provider.failing = options.failing ?? false
  const store = new MemorySessionStore()
  const record = await store.create()
  record.messages = seed

  const session = new Session({
    scope: { gateway: 'cli', chatId: 'c' },
    provider,
    model: 'm',
    system: 'BASE',
    registry: options.registry ?? createToolRegistry(),
    memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
    cwd: process.cwd(),
    record,
    store,
    sessions: {
      ...DEFAULT_SESSIONS,
      maxInputTokens: options.maxInputTokens ?? 2400,
      keepTurns: options.keepTurns ?? 1,
      // Naming a session is a model call of its own, and what this test counts is
      // the requests a fold makes.
      generateTitles: false,
      contextWindow: options.contextWindow,
    },
    modelProfile: async (model) => {
      const context = await options.lookup?.(model)
      return context === undefined ? undefined : { id: model, context }
    },
  })

  const events = []
  for await (const event of session.send('brand new question')) events.push(event)
  return { provider, session, events }
}

const longSeed = (): Message[] => [
  text('user', `first ${'x'.repeat(2000)}`),
  ...toolTurn('call_1'),
  text('user', `second ${'y'.repeat(2000)}`),
  text('assistant', `reply ${'z'.repeat(2000)}`),
  text('user', 'third'),
  text('assistant', 'third reply'),
]

/**
 * The ceiling the folding tests name: room above the fixed cost of a request — the system
 * prompt *and* the tool schemas that go beside it — which is what folding needs to have
 * anywhere to fold into. Read from the session that counts it rather than pinned to a
 * number chosen once: what is tested here is folding a transcript, not how big the catalog
 * happens to be, and a pinned number is wrong the moment a tool gains a sentence.
 */
async function foldingBudget(): Promise<number> {
  const { session } = await compactingSession([], { maxInputTokens: 1_000_000 })
  return (session.stats().fixedTokens ?? 0) + 1_000
}

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
    scope: { gateway: 'cli', chatId: 'c' },
    provider,
    model: 'm',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
    cwd: process.cwd(),
    record,
    store,
    sessions: {
      ...DEFAULT_SESSIONS,
      maxInputTokens: 100_000,
      keepTurns: overrides.keepTurns ?? 1,
      compaction: overrides.compaction ?? true,
      generateTitles: false,
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

  it('prices a signed thought and not an unsigned one', () => {
    // A thought never goes back to the provider, so it costs nothing — unless
    // Anthropic signed it, in which case it rides every later request.
    const thought = 'w'.repeat(400)
    const unsigned = estimateTokens([
      { role: 'assistant', content: [{ type: 'reasoning', text: thought }] },
    ])
    const signed = estimateTokens([
      { role: 'assistant', content: [{ type: 'reasoning', text: thought, signature: 'sig' }] },
    ])

    expect(unsigned).toBe(0)
    expect(signed).toBeGreaterThan(90)
  })
})

describe('estimateTools', () => {
  it('prices the schemas that go on the wire, not the signatures', () => {
    const specs = createToolRegistry().specs()

    expect(estimateTools([])).toBe(0)
    // The schemas are the larger half of the catalog: the prose index in the
    // system prompt carries the same descriptions and is counted separately.
    expect(estimateTools(specs)).toBeGreaterThan(estimateText(specs.map((tool) => tool.description).join('')))
  })
})

describe('contextBudget', () => {
  const sessions = { ...DEFAULT_SESSIONS, maxInputTokens: 12_000 }

  it('takes a share of the window, and the fallback when nothing knows it', () => {
    expect(contextBudget(sessions, 100_000)).toBe(70_000)
    expect(contextBudget(sessions, undefined)).toBe(12_000)
  })

  it('leaves room to answer when the window turns out tiny', () => {
    expect(contextBudget({ ...sessions, compactAt: 0.7 }, 1000)).toBe(1024)
  })

  it('has no budget at all when compaction is off', () => {
    expect(contextBudget({ ...sessions, compaction: false }, 100_000)).toBeUndefined()
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

describe('planCutUnderBudget', () => {
  it('stays at the floor when the turns it protects fit', () => {
    const messages = longSeed()
    const budget = estimateTokens(messages) + 100
    const cut = planCutUnderBudget(messages, { keepTurns: 1, budget, fixed: 0 })

    // The same boundary the plain floor would pick.
    expect(cut).toBe(planCut(messages, 1))
    expect(messages[cut]!.role).toBe('user')
  })

  it('recuses past the floor when the protected turns are themselves too big', () => {
    const big = text('user', `big ${'w'.repeat(4000)}`)
    const last = text('user', 'last')
    const messages = [text('user', 'first'), text('assistant', 'a'), big, text('assistant', 'r'), last]
    // Room for the last turn alone, but not for the big one beside it.
    const budget = 300 + estimateTokens([last])
    const cut = planCutUnderBudget(messages, { keepTurns: 2, budget, fixed: 0 })

    // Two turns were asked to stay; only the last one fits, so the cut lands
    // before the big turn instead of carrying it over the ceiling.
    expect(planCut(messages, 2)).toBe(messages.indexOf(big))
    expect(cut).toBe(messages.indexOf(last))
    expect(messages[cut]!.role).toBe('user')
  })

  it('has no cut when even the last turn is over the budget', () => {
    const messages = [text('user', 'first'), text('assistant', 'a'), text('user', 'x'.repeat(4000))]

    expect(planCutUnderBudget(messages, { keepTurns: 2, budget: 10, fixed: 0 })).toBe(0)
  })

  it('has nothing to cut with no user turn at all', () => {
    expect(
      planCutUnderBudget([text('assistant', 'only')], { keepTurns: 1, budget: 10, fixed: 0 }),
    ).toBe(0)
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

  it('gives up after one attempt when the call was cut off by its own budget', async () => {
    const provider = new ScriptedProvider()
    provider.hanging = true

    const result = await summarize({ provider, model: 'm', dropped: longSeed(), timeoutMs: 10 })

    // A retry is cut off at the same budget, so it would only cost the wait and
    // another warning — and the second call was the one that never got cancelled.
    expect(result).toBeNull()
    expect(provider.efforts).toEqual(['low'])
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

describe('generateTitle', () => {
  const opening = [text('user', 'how do I fold a transcript?'), text('assistant', 'with planCut')]

  it('asks for a short name and answers with what came back', async () => {
    const provider = new ScriptedProvider()

    expect(await generateTitle({ provider, model: 'm', messages: opening })).toBe('OLD_TURNS_SUMMARY')
    expect(provider.systems.at(-1)).toContain('name a conversation')
    // Mechanical work nobody waits on, so it asks for the cheapest reasoning —
    // and the execution log can tell this call from a fold or a recap.
    expect(provider.efforts).toEqual(['low'])
    expect(provider.purposes).toEqual(['title'])
  })

  it('hands the call the opening turn, both sides of it', async () => {
    const provider = new ScriptedProvider()

    await generateTitle({ provider, model: 'm', messages: opening })

    expect(provider.prompts.at(-1)).toContain('how do I fold a transcript?')
    expect(provider.prompts.at(-1)).toContain('with planCut')
  })

  it('returns null when nobody has said anything yet', async () => {
    const provider = new ScriptedProvider()
    expect(await generateTitle({ provider, model: 'm', messages: [text('assistant', 'hi')] })).toBeNull()
    expect(provider.systems).toEqual([])
  })

  it('returns null rather than throwing when the call fails', async () => {
    const provider = new ScriptedProvider()
    provider.failing = true
    expect(await generateTitle({ provider, model: 'm', messages: opening })).toBeNull()
  })

  it('reads a name out of the answer', () => {
    expect(cleanTitle('  "Fix the session list."  ')).toBe('Fix the session list')
    expect(cleanTitle('`Fold a transcript`')).toBe('Fold a transcript')
    expect(cleanTitle('one\n\ntwo')).toBe('one two')
  })

  it('refuses an answer that is not a name', () => {
    expect(cleanTitle('')).toBeNull()
    expect(cleanTitle('   ')).toBeNull()
    expect(cleanTitle('.')).toBeNull()
    // A sentence is not a name, and half of one is not what the rule was for.
    expect(cleanTitle('a'.repeat(81))).toBeNull()
  })
})

describe('Session compaction', () => {
  it('summarizes the dropped turns and keeps them out of the transcript', async () => {
    // The ceiling is read rather than left to the default, so what is measured is
    // folding a transcript and not the size of the catalog — see `foldingBudget`.
    const { provider, session } = await compactingSession(longSeed(), {
      maxInputTokens: await foldingBudget(),
    })

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
    const { provider, session, events } = await compactingSession(longSeed(), {
      failing: true,
      maxInputTokens: await foldingBudget(),
    })

    const system = provider.systems.at(-1)!
    expect(system).not.toContain('## Earlier in this conversation')

    expect(session.messages[0]!.role).toBe('user')
    expect(session.messages.length).toBeLessThan(longSeed().length)
    // The turns went anyway — a request that fits beats one the provider rejects —
    // and the report says so rather than claiming a summary that was never written.
    expect(events.find((event) => event.type === 'compacted')).toMatchObject({ summarized: false })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('says the fold is running, then what it came to, before the turn produces anything', async () => {
    const { events } = await compactingSession(longSeed(), { maxInputTokens: await foldingBudget() })

    const announcing = events.findIndex((event) => event.type === 'compacting')
    const at = events.findIndex((event) => event.type === 'compacted')
    expect(at).toBeGreaterThanOrEqual(0)
    // Both arrive before the turn's own output, and in that order: the summary is a
    // model call of its own, so a surface names the wait as it starts — otherwise
    // its seconds are read as the model being slow — and reports the fold once it
    // is over.
    expect(announcing).toBeGreaterThanOrEqual(0)
    expect(announcing).toBeLessThan(at)
    expect(at).toBeLessThan(events.findIndex((event) => event.type === 'done'))
    // What it came to is what it saved, not only that something happened.
    const fold = events[at] as { summarized: boolean; ms: number; folded: number; tokens: number }
    expect(fold.summarized).toBe(true)
    expect(fold.ms).toBeGreaterThanOrEqual(0)
    expect(fold.folded).toBeGreaterThan(0)
    expect(fold.tokens).toBeGreaterThan(0)
  })

  it('says nothing when there was nothing to compact', async () => {
    // Already over budget, but there is no user turn to cut on — so no summary
    // call is made and there is no cost to report.
    const { events } = await compactingSession([])

    expect(events.some((event) => event.type === 'compacted')).toBe(false)
    // And no wait is announced either: a fold that was never bought must not be
    // named as running.
    expect(events.some((event) => event.type === 'compacting')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('measures against the model window, not the fallback, when one is known', async () => {
    // A 100k window at 70% is 70k: this transcript is nowhere near it, where the
    // configured fallback would have summarized it. The fallback is what a fixed
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
    const { session } = await compactingSession(longSeed(), {
      lookup: async () => undefined,
      maxInputTokens: 40,
    })

    expect(session.stats().maxInputTokens).toBe(40)
  })

  it('does nothing when compaction is off', async () => {
    const store = new MemorySessionStore()
    const record = await store.create()
    record.messages = longSeed()
    const provider = new ScriptedProvider()

    const session = new Session({
      scope: { gateway: 'cli', chatId: 'c' },
      provider,
      model: 'm',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-comp-')) }),
      cwd: process.cwd(),
      record,
      store,
      sessions: { ...DEFAULT_SESSIONS, maxInputTokens: 40, keepTurns: 1, compaction: false, generateTitles: false },
    })

    for await (const _event of session.send('another one')) {
      // drain
    }

    expect(provider.systems.some((system) => system.includes('compress a conversation'))).toBe(false)
    expect(session.stats().compacted).toBe(false)
  })

  it('does not summarize when the prompt alone is over the ceiling', async () => {
    // A transcript of almost nothing and a budget far above it — but the tool
    // list and environment that ride along with every request do not fit. There
    // is nothing a summary could fold away here, so none is bought; that is the
    // work the old code did on every turn for nothing.
    const seed = [text('user', 'first'), text('assistant', 'ok'), text('user', 'second')]
    const { provider, session, events } = await compactingSession(seed, { maxInputTokens: 500 })

    expect(estimateTokens(seed)).toBeLessThan(100)
    expect(provider.systems.some((system) => system.includes('compress a conversation'))).toBe(false)
    expect(events.some((event) => event.type === 'compacted')).toBe(false)
    expect(session.stats().compacted).toBe(false)
  })

  it('recuses past the keepTurns floor instead of summarizing every turn', async () => {
    // The last two turns are asked to stay, but the big one beside the last does
    // not fit above what every request carries — so it is folded too, rather than
    // riding the request over the budget and being summarized again next turn.
    const big = text('user', `big ${'w'.repeat(20_000)}`)
    const seed = [
      text('user', 'first'),
      text('assistant', 'a'),
      big,
      text('assistant', 'r'),
      text('user', 'last'),
    ]
    const { session, events } = await compactingSession(seed, {
      maxInputTokens: await foldingBudget(),
      keepTurns: 2,
    })

    expect(events.some((event) => event.type === 'compacted')).toBe(true)
    // Only the last user turn survived ahead of the new question; the floor would
    // have kept the big turn beside it.
    expect(session.messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'last' }],
    })
    expect(session.stats().compacted).toBe(true)
  })

  it('stops paying for a summary that cannot get under the ceiling', async () => {
    // Even the last turn alone, plus the prompt, is over the ceiling: no fold can
    // bring the request under, so no model call is made for it.
    const huge = text('user', `huge ${'w'.repeat(20_000)}`)
    const seed = [text('user', 'first'), text('assistant', 'a'), huge]
    const before = seed.length
    const { provider, session, events } = await compactingSession(seed, { maxInputTokens: 4000, keepTurns: 2 })

    expect(events.some((event) => event.type === 'compacted')).toBe(false)
    expect(provider.systems.some((system) => system.includes('compress a conversation'))).toBe(false)
    // Nothing was folded: the transcript is the seed, the question and the answer.
    expect(session.messages.length).toBe(before + 2)
  })

  it('counts the tool schemas in what every request carries', async () => {
    // The same seed and ceiling twice; only the catalog differs. The schemas are
    // the larger half of what a request carries, and they used to sit outside the
    // count — which is how a request was measured as fitting while it was over.
    const empty = await compactingSession(longSeed(), {
      maxInputTokens: 100_000,
      registry: new ToolRegistry([]),
    })
    const full = await compactingSession(longSeed(), { maxInputTokens: 100_000 })
    const catalog = estimateTools(createToolRegistry().specs())

    expect(catalog).toBeGreaterThan(0)
    expect(
      full.session.stats().fixedTokens! - empty.session.stats().fixedTokens!,
    ).toBeGreaterThanOrEqual(catalog)
  })
})
