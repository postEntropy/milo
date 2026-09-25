import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events.js'
import type { HistoryEntry, HistoryWriter } from '../src/core/history.js'
import { installMemory, type MemoryScope } from '../src/core/memory/index.js'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import { TurnIndex } from '../src/core/memory/turns.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { Session, type SessionOptions } from '../src/core/session.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { createToolRegistry } from '../src/core/tools/index.js'

/**
 * The notes a real model gets to read: the `## What you remember` block exactly
 * as `buildSystemPrompt` writes it. Parsing it here is the whole point — nothing
 * else of the conversation reaches the model, so whatever this returns is all it
 * could answer from.
 */
function remembered(system: string): string[] {
  const block = /<memories>\n([\s\S]*?)\n<\/memories>/.exec(system)
  if (!block?.[1]) return []
  return block[1].split('\n').map((line) => line.replace(/^-\s*/, ''))
}

/**
 * Stands in for the model and answers the way one does: out of the notes in its
 * own system prompt. It is shown no other turn, so an answer that comes back is
 * proof the note travelled all the way into the request — and an empty store is
 * answered with "I do not know", which is what keeps every assertion below
 * falsifiable instead of always true.
 */
class NoteReadingProvider implements Provider {
  readonly id = 'note-reading'
  readonly systems: string[] = []
  private calls = 0

  /** The model's opening move, for a turn where it should reach for a tool. */
  constructor(private readonly script: StreamEvent[] = []) {}

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    this.systems.push(req.system ?? '')
    if (this.calls === 1 && this.script.length > 0) {
      for (const event of this.script) yield event
      return
    }
    const note = remembered(req.system ?? '')[0]
    yield { type: 'text', delta: note ?? 'I do not know' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

/** The log a session writes, in the shape `fileHistory` writes it. */
function logWriter(dir: string): HistoryWriter {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)
  return {
    append(entries: HistoryEntry[]) {
      appendFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
    },
  }
}

function install(scope: MemoryScope, provider: Provider, extra: Partial<SessionOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-recall-'))
  const log = path.join(dir, 'history')

  // Wired the way `bootstrap.ts` wires it: the facts in their own store, the log
  // beside them, and the index recall reads the person's words out of.
  const memory = installMemory(
    new SqliteMemory({ dir: path.join(dir, 'memory') }),
    new TurnIndex({ dir: log }),
  )
  const store = new MemorySessionStore()

  // A fresh session for the same scope, as `/new` makes one: its transcript is
  // empty and the memory behind the scope is the only thing it can draw on.
  const build = async (forScope: MemoryScope = scope) =>
    new Session({
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory,
      store,
      scope: forScope,
      record: await store.create(),
      cwd: process.cwd(),
      provider,
      history: logWriter(log),
      maxSteps: 4,
      ...extra,
    })

  return { build, memory, scope }
}

async function ask(session: Session, input: string) {
  const events: AgentEvent[] = []
  for await (const event of session.send(input)) events.push(event)
  const answer = events
    .filter(
      (event): event is Extract<AgentEvent, { type: 'text-delta' }> => event.type === 'text-delta',
    )
    .map((event) => event.delta)
    .join('')
  return { answer, events }
}

describe('a fact said in one message, asked about in the next', () => {
  it('answers from it within the same session', async () => {
    const provider = new NoteReadingProvider()
    const { build } = install({ gateway: 'cli', conversationId: 'editor' }, provider)
    const session = await build()

    const before = await ask(session, 'my editor is Neovim')
    // Nothing was said yet, so the model has nothing to answer from.
    expect(before.answer).toBe('I do not know')

    // The turn went to the history log, the index read it back, and the question
    // is answered from the person's own words — no fact had to be saved for this.
    const after = await ask(session, 'which editor do I use?')
    expect(after.answer).toContain('Neovim')
    // And it reached the request itself, where the model reads it.
    expect(provider.systems.at(-1)).toContain('## What you remember')
    expect(provider.systems.at(-1)).toContain('Neovim')
  })

  it('answers from it in a brand-new session whose transcript is empty', async () => {
    const provider = new NoteReadingProvider()
    const { build } = install({ gateway: 'cli', conversationId: 'editor-new' }, provider)

    await ask(await build(), 'my editor is Neovim')

    // Same scope, no turns at all: the transcript cannot be the source, so the
    // note can only have come through memory.
    const second = await build()
    expect(second.messages).toHaveLength(0)

    const { answer } = await ask(second, 'which editor do I use?')
    expect(answer).toContain('Neovim')
    expect(second.messages).toHaveLength(2)
  })

  it('answers "I do not know" when nothing was ever stored', async () => {
    const { build } = install(
      { gateway: 'cli', conversationId: 'editor-unknown' },
      new NoteReadingProvider(),
    )
    const { answer } = await ask(await build(), 'which editor do I use?')

    // The control: without this, an always-remembering assertion would prove
    // nothing about recall.
    expect(answer).toBe('I do not know')
    expect(answer).not.toContain('Neovim')
  })

  it('fetches a fact the remember tool saved, in a later session', async () => {
    const provider = new NoteReadingProvider([
      {
        type: 'tool-call',
        id: 'c1',
        name: 'remember',
        args: { facts: ['Renato deploys on Fridays'] },
      },
      { type: 'done', finishReason: 'tool_calls' },
    ])
    const { build } = install({ gateway: 'cli', conversationId: 'deploy' }, provider)

    const saved = await ask(await build(), 'note that for later')
    expect(saved.events).toContainEqual(
      expect.objectContaining({ type: 'tool-end', name: 'remember', isError: false }),
    )

    const { answer } = await ask(await build(), 'what happens on fridays?')
    expect(answer).toContain('Renato deploys on Fridays')
  })

  it('answers in one surface what was said in another', async () => {
    const provider = new NoteReadingProvider()
    const { build } = install({ gateway: 'cli', conversationId: 'unused' }, provider)

    await ask(await build({ gateway: 'cli', conversationId: 'main' }), 'my editor is Neovim')

    const { answer } = await ask(
      await build({ gateway: 'telegram', conversationId: '8924510981' }),
      'which editor do I use?',
    )
    expect(answer).toContain('Neovim')
  })
})

describe('reading a finished turn for facts', () => {
  it('files them without holding the answer', async () => {
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const provider: Provider = {
      id: 'gated',
      async *stream(): AsyncGenerator<StreamEvent> {
        calls += 1
        if (calls === 1) {
          yield { type: 'text', delta: 'anotado' }
          yield { type: 'done', finishReason: 'stop' }
          return
        }
        // The extraction answers only when this test lets it, which is what makes
        // "the turn does not wait for it" observable rather than asserted.
        await held
        yield { type: 'text', delta: 'O editor do Renato e o Neovim' }
      },
    }

    const { build, memory, scope } = install(
      { gateway: 'cli', conversationId: 'derive' },
      provider,
      { derive: true },
    )
    const session = await build()

    const { answer } = await ask(session, 'meu editor e o Neovim')
    expect(answer).toBe('anotado')

    release()
    await session.settle()

    const notes = await memory.list(scope)
    expect(notes.some((note) => note.text.includes('Neovim'))).toBe(true)
    // A fact about the person, not the exchange: the transcript is untouched.
    expect(session.messages).toHaveLength(2)
  })

  it('costs nothing extra when the install has it off', async () => {
    let calls = 0
    const provider: Provider = {
      id: 'counting',
      async *stream(): AsyncGenerator<StreamEvent> {
        calls += 1
        yield { type: 'text', delta: 'certo' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const { build } = install({ gateway: 'cli', conversationId: 'no-derive' }, provider)
    const session = await build()
    await ask(session, 'oi')
    await session.settle()

    expect(calls).toBe(1)
  })
})
