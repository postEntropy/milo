import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events.js'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import { DEFAULT_RECALL_LIMIT, type Memory, type MemoryScope } from '../src/core/memory/index.js'
import type {
  ChatRequest,
  Provider,
  ReasoningEffort,
  StreamEvent,
} from '../src/core/providers/types.js'
import type { HistoryEntry } from '../src/core/history.js'
import { Session, type SessionOptions } from '../src/core/session.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { MemoryRecapStore } from '../src/core/sessions/recap.js'
import { FileSessionStore } from '../src/core/sessions/file-store.js'
import { createToolRegistry } from '../src/core/tools/index.js'

type Extra = Omit<SessionOptions, 'record' | 'scope' | 'store' | 'provider' | 'memory'>

class CapturingProvider implements Provider {
  readonly id = 'capturing'
  lastSystem?: string
  lastMaxTokens?: number
  lastEffort?: ReasoningEffort

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.lastSystem = req.system
    this.lastMaxTokens = req.maxTokens
    this.lastEffort = req.reasoningEffort
    yield { type: 'text', delta: 'SECRET_ASSISTANT_REPLY' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

async function run(input: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
  const provider = new CapturingProvider()
  const memory = new SqliteMemory({ dir })
  const store = new MemorySessionStore()
  const scope: MemoryScope = { gateway: 'cli', conversationId: 't' }
  const base: Extra = {
    model: 'test-model',
    system: 'BASE',
    registry: createToolRegistry(),
    cwd: process.cwd(),
    maxSteps: 4,
  }

  const record = await store.create()
  const session = new Session({ ...base, provider, memory, store, scope, record })

  const events = []
  for await (const event of session.send(input)) events.push(event)
  return { provider, memory, store, scope, base, record, session, events }
}

/** A session on a throwaway store, for testing the provider's behaviour. */
async function sessionWith(provider: Provider, extra: Partial<SessionOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
  const memory = new SqliteMemory({ dir })
  const store = new MemorySessionStore()
  const scope: MemoryScope = { gateway: 'cli', conversationId: 'abort' }
  const record = await store.create()
  const session = new Session({
    model: 'test-model',
    system: 'BASE',
    registry: createToolRegistry(),
    memory,
    store,
    scope,
    record,
    cwd: process.cwd(),
    provider,
    maxSteps: 4,
    ...extra,
  })
  return { session, memory, scope }
}

function abortError(): Error {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

describe('Session', () => {
  it('builds a system prompt with environment and tools', async () => {
    const { provider } = await run('hello there')
    expect(provider.lastSystem).toContain('## Environment')
    expect(provider.lastSystem).toContain(`Working directory: ${process.cwd()}`)
    expect(provider.lastSystem).toContain('## Available tools')
    expect(provider.lastSystem).toContain('read_file(path, offset?, limit?)')
  })

  it('leaves the store of facts alone and keeps the turn in the log', async () => {
    const { memory, scope } = await run('my editor is Neovim')

    // What was typed is in the history log, and recall reads it from there. The
    // store is for what the model decided was worth keeping: a session writing
    // the turn into it as well is the copy this design removed. The reply is not
    // in either — a reply is not a fact.
    expect(await memory.recall(scope, 'which editor do I like?', { limit: 5 })).toEqual([])
    expect(await memory.recall(scope, 'SECRET_ASSISTANT_REPLY', { limit: 5 })).toEqual([])
  })

  it('takes up a message sent mid-turn, and writes it down as it arrives', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const memory = new SqliteMemory({ dir })
    // A file store, not the in-memory one: it hands back a copy, so reading it
    // mid-turn says what is really on disk.
    const store = new FileSessionStore({ dir: path.join(dir, 'sessions') })
    const scope: MemoryScope = { gateway: 'cli', conversationId: 'steer' }
    const record = await store.create()
    const logged: HistoryEntry[] = []

    const steering: string[] = []
    let step = 0
    let onDiskWhenAnswered: string[] | undefined

    const provider: Provider = {
      id: 'steering',
      async *stream(): AsyncGenerator<StreamEvent> {
        step += 1
        if (step === 1) {
          yield { type: 'text', delta: 'let me look' }
          // The user corrects the answer while it is still coming in.
          steering.push('the config lives in ~/.milo')
          yield { type: 'done', finishReason: 'stop' }
          return
        }
        // Answering the correction, it has to be on disk already: a crash here
        // must not lose what the user said.
        onDiskWhenAnswered = (await store.load(record.id))?.messages.map((message) => message.role)
        yield { type: 'text', delta: 'checking there' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const session = new Session({
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory,
      store,
      scope,
      record,
      cwd: process.cwd(),
      provider,
      maxSteps: 4,
      history: { append: (entries) => logged.push(...entries) },
    })

    const events = []
    for await (const event of session.send('where does the config live?', { steering })) {
      events.push(event)
    }

    expect(events.filter((event) => event.type === 'steer')).toEqual([
      { type: 'steer', text: 'the config lives in ~/.milo' },
    ])
    // One turn, two steps — not a second turn.
    expect(step).toBe(2)
    expect(onDiskWhenAnswered).toEqual(['user', 'assistant', 'user'])
    expect(
      logged.filter((entry) => entry.kind === 'user').map((entry) => entry.text),
    ).toEqual(['where does the config live?', 'the config lives in ~/.milo'])
  })

  it('lets the model save a fact with the remember tool', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const memory = new SqliteMemory({ dir })
    const store = new MemorySessionStore()
    const scope: MemoryScope = { gateway: 'cli', conversationId: 'remember' }
    const record = await store.create()

    // First step asks for a tool, second answers — the shape of a real turn.
    let step = 0
    const provider: Provider = {
      id: 'remembering',
      async *stream(): AsyncGenerator<StreamEvent> {
        step += 1
        if (step === 1) {
          yield {
            type: 'tool-call',
            id: 'c1',
            name: 'remember',
            args: { facts: ['Renato deploys on Fridays'] },
          }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'noted' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const session = new Session({
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory,
      store,
      scope,
      record,
      cwd: process.cwd(),
      provider,
      maxSteps: 4,
    })

    const events = []
    for await (const event of session.send('note that for later')) events.push(event)

    const toolEnd = events.find((event) => event.type === 'tool-end')
    expect(toolEnd).toMatchObject({ name: 'remember', isError: false })

    // Recalled by a later question, through the same scope the tool wrote to.
    const hits = await memory.recall(scope, 'what happens on fridays?', { limit: 5 })
    expect(hits.some((hit) => hit.text.includes('Fridays'))).toBe(true)
  })

  it('persists the transcript and reloads it into a new session', async () => {
    const { store, session, scope, base, provider, memory } = await run('what is the package?')

    const saved = await store.load(session.id)
    expect(saved).not.toBeNull()
    expect(saved!.messages.map((message) => message.role)).toEqual(['user', 'assistant'])

    const reloaded = new Session({ ...base, provider, memory, store, scope, record: saved! })
    expect(reloaded.id).toBe(session.id)
    expect(reloaded.messages).toHaveLength(2)
  })

  it('reports stats that match the transcript', async () => {
    const { session } = await run('hello there')
    const stats = session.stats()

    expect(stats.id).toBe(session.id)
    // The conversation, not the provider's list: one question and one answer.
    expect(stats.messages).toBe(2)
    expect(stats.turns).toBe(1)
    expect(stats.tokens).toBeGreaterThan(0)
    expect(stats.compacted).toBe(false)
    // The system prompt is counted too: it goes with every request and the
    // transcript number alone would understate what the provider receives.
    expect(stats.systemTokens).toBeGreaterThan(0)
  })

  it('clears the transcript but keeps the session identity', async () => {
    const { session, store } = await run('hello there')
    await session.clear()

    expect(session.messages).toHaveLength(0)
    expect(session.id).toMatch(/^[a-z]+-[a-z]+-\d{1,3}$/)
    expect((await store.load(session.id))!.messages).toHaveLength(0)
  })

  it('keeps remembered facts when a new session starts on the same scope', async () => {
    const { store, scope, base, provider, memory } = await run('my editor is Neovim')
    // A fact, the way the model saves one. The turn itself only lives in the log,
    // which is why this asks the store directly.
    await memory.remember(scope, [{ text: 'Meu editor e o Neovim' }])

    const record = await store.create()
    const fresh = new Session({ ...base, provider, memory, store, scope, record })
    for await (const _event of fresh.send('which editor do I use?')) {
      // drain
    }

    expect(fresh.messages).toHaveLength(2)
    expect(provider.lastSystem).toContain('## What you remember')
    expect(provider.lastSystem).toContain('Neovim')
  })

  it('reports a stopped turn as stopped, not as a failure', async () => {
    const controller = new AbortController()
    const provider: Provider = {
      id: 'stopping',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        // What a real provider does once the request it is streaming is gone.
        if (req.signal?.aborted) throw abortError()
        yield { type: 'text', delta: 'partial' }
      },
    }

    const entries: HistoryEntry[] = []
    const { session } = await sessionWith(provider, {
      history: { append: (next) => entries.push(...next) },
    })
    controller.abort()

    const events: AgentEvent[] = []
    for await (const event of session.send('remember this', { signal: controller.signal })) {
      events.push(event)
    }

    expect(events.some((event) => event.type === 'aborted')).toBe(true)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    // What was asked is in the log even though the turn was stopped: a stop is
    // the end of a turn, not a reason for it to leave no trace.
    expect(entries.some((entry) => entry.kind === 'user')).toBe(true)
  })

  it('still reports a genuine failure as an error', async () => {
    const provider: Provider = {
      id: 'failing',
      // biome-ignore lint/correctness/useYield: a provider that fails right away yields nothing
      async *stream(): AsyncGenerator<StreamEvent> {
        throw new Error('provider exploded')
      },
    }

    const { session } = await sessionWith(provider)
    const events: AgentEvent[] = []
    for await (const event of session.send('hello')) events.push(event)

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      message: 'provider exploded',
    })
    expect(events.some((event) => event.type === 'aborted')).toBe(false)
  })

  it('passes the configured output ceiling down to the provider', async () => {
    const provider = new CapturingProvider()
    const { session } = await sessionWith(provider, { maxTokens: 1234 })
    for await (const _event of session.send('hello')) {
      // drain
    }

    expect(provider.lastMaxTokens).toBe(1234)
  })

  it('leaves the ceiling to the wire when none is configured', async () => {
    const provider = new CapturingProvider()
    const { session } = await sessionWith(provider)
    for await (const _event of session.send('hello')) {
      // drain
    }

    expect(provider.lastMaxTokens).toBeUndefined()
  })

  it('answers from as many notes as the install asks for', async () => {
    const limits: (number | undefined)[] = []
    const memory: Memory = {
      remember: async () => {},
      recall: async (_scope, _query, opts) => {
        limits.push(opts?.limit)
        return []
      },
      list: async () => [],
      forget: async () => false,
    }
    const provider = new CapturingProvider()

    const defaults = await sessionWith(provider, { memory })
    for await (const _event of defaults.session.send('one')) {
      // drain
    }
    expect(limits.at(-1)).toBe(DEFAULT_RECALL_LIMIT)

    const configured = await sessionWith(provider, { memory, recallLimit: 2 })
    for await (const _event of configured.session.send('two')) {
      // drain
    }
    expect(limits.at(-1)).toBe(2)
  })

  it('asks for medium when nothing set the effort', async () => {
    const provider = new CapturingProvider()
    const { session } = await sessionWith(provider)
    for await (const _event of session.send('hello')) {
      // drain
    }

    // Never absent: an absent field left the choice to whatever each provider
    // and model made of it — the value nobody could name.
    expect(provider.lastEffort).toBe('medium')
  })

  it('reads the effort per turn, so a change lands on the next one', async () => {
    const provider = new CapturingProvider()
    let effort: ReasoningEffort = 'low'
    const { session } = await sessionWith(provider, { reasoningEffort: () => effort })
    for await (const _event of session.send('hello')) {
      // drain
    }
    expect(provider.lastEffort).toBe('low')

    // `/effort high` changes what the session reads, not the session itself.
    effort = 'high'
    for await (const _event of session.send('again')) {
      // drain
    }
    expect(provider.lastEffort).toBe('high')
  })

  it('tells the model which browser it has, and whether it is up', async () => {
    // The model asked, out loud, and went looking through `ps` and `ss` instead:
    // the answer belongs in the prompt, where it costs a line.
    const provider = new CapturingProvider()
    const { session } = await sessionWith(provider, {
      browser: () => ({
        binary: '/usr/bin/chromium',
        headless: true,
        profile: 'its own',
        running: true,
        port: 38551,
      }),
    })
    for await (const _event of session.send('qual navegador voce usa?')) {
      // drain
    }

    expect(provider.lastSystem).toContain('Browser right now: /usr/bin/chromium, headless, its own profile, running on port 38551')
    // And it is told where that came from, so a remembered note does not win.
    expect(provider.lastSystem).toContain('These lines are the live state')
  })

  it('says nothing about a browser on an install that has none', async () => {
    const { provider } = await run('hello')
    expect(provider.lastSystem).not.toContain('Browser right now')
  })

  it('keeps the reasoning in the transcript, and logs the turn', async () => {
    const entries: HistoryEntry[] = []
    const provider: Provider = {
      id: 'thinking',
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: 'reasoning', delta: 'weighing the options' }
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const { session } = await sessionWith(provider, {
      history: { append: (batch) => entries.push(...batch) },
    })
    for await (const _event of session.send('think about it')) {
      // drain
    }

    const parts = session.messages.flatMap((message) => message.content)
    expect(parts.filter((part) => part.type === 'reasoning')).toEqual([
      { type: 'reasoning', text: 'weighing the options' },
    ])

    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant'])
    expect(entries[0]).toMatchObject({ text: 'think about it', session: session.id })
    expect(entries[1]).toMatchObject({
      text: 'done',
      reasoning: 'weighing the options',
      session: session.id,
    })
  })

  it('logs the tools a turn ran, with what they returned', async () => {
    const entries: HistoryEntry[] = []
    let step = 0
    const provider: Provider = {
      id: 'tooling',
      async *stream(): AsyncGenerator<StreamEvent> {
        step += 1
        if (step === 1) {
          yield { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'package.json' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'it is milo' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const { session } = await sessionWith(provider, {
      history: { append: (batch) => entries.push(...batch) },
    })
    for await (const _event of session.send('what is this project?')) {
      // drain
    }

    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'tool', 'assistant'])
    expect(entries[1]).toMatchObject({
      tool: { name: 'read_file', args: { path: 'package.json' }, isError: false },
    })
    expect(entries[1]?.tool?.result).toContain('milo')
  })

  it('keeps two steps of one answer from running into each other in the log', async () => {
    const entries: HistoryEntry[] = []
    let step = 0
    const provider: Provider = {
      id: 'two-steps',
      async *stream(): AsyncGenerator<StreamEvent> {
        step += 1
        if (step === 1) {
          // What is said before reaching for a tool, and what is said after it,
          // are two things — and the log holds the turn's answer as one string.
          yield { type: 'text', delta: 'deixa eu ver o arquivo.' }
          yield { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'package.json' } }
          yield { type: 'done', finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text', delta: 'e o milo.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const { session } = await sessionWith(provider, {
      history: { append: (batch) => entries.push(...batch) },
    })
    for await (const _event of session.send('o que e isso?')) {
      // drain
    }

    const answer = entries.find((entry) => entry.kind === 'assistant')
    expect(answer?.text).toBe('deixa eu ver o arquivo.\n\ne o milo.')
  })
})

describe('a session another writer has moved on from', () => {
  it('adopts what was written elsewhere and says the transcript is wider than the screen', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const store = new FileSessionStore({ dir: path.join(dir, 'sessions') })
    const record = await store.create()
    const provider = new CapturingProvider()
    const session = new Session({
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new SqliteMemory({ dir }),
      store,
      scope: { gateway: 'cli', conversationId: 'elsewhere' },
      record,
      cwd: process.cwd(),
      provider,
      maxSteps: 4,
    })

    // The other writer appends to the same session while this one holds its copy.
    const other = (await store.load(record.id))!
    other.messages.push({ role: 'user', content: [{ type: 'text', text: 'from elsewhere' }] })
    await store.save(other, other.version)

    const events: AgentEvent[] = []
    for await (const event of session.send('hello there')) events.push(event)

    // Not refused: the stored transcript was taken as the base, and the surface
    // is told it answers from more than it has shown.
    expect(events).toContainEqual({ type: 'rebased', added: 1, compacted: false })
    expect(events.some((event) => event.type === 'error')).toBe(false)
    // And the turn it wrote builds on top of that, rather than replacing it.
    expect((await store.load(record.id))!.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'from elsewhere' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'SECRET_ASSISTANT_REPLY' }] },
    ])
  })
})

describe('recapping a session another writer moved on', () => {
  it('leaves a recap that describes a newer transcript than this copy has', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const store = new MemorySessionStore({ now: () => 100 })
    const record = await store.create()
    record.messages.push({ role: 'user', content: [{ type: 'text', text: 'earlier' }] })

    const recaps = new MemoryRecapStore()
    // Written by somebody that had already seen more of the transcript.
    await recaps.write({ session: record.id, text: 'newer', sourceUpdatedAt: 200, at: 200 })

    const session = new Session({
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new SqliteMemory({ dir }),
      store,
      recaps,
      scope: { gateway: 'cli', conversationId: 'recap' },
      record,
      cwd: process.cwd(),
      provider: new CapturingProvider(),
      maxSteps: 4,
    })

    await session.recap()

    // Not replaced by one describing less, and not paid for: the model call is
    // skipped rather than made and thrown away.
    expect((await recaps.read(record.id))?.text).toBe('newer')
  })
})

describe('a reader that stops at the wait', () => {
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('gives the lease back rather than holding the session for good', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const store = new FileSessionStore({ dir: path.join(dir, 'sessions') })
    const record = await store.create()
    const gate = deferred()
    let held = 0
    const provider: Provider = {
      id: 'gated',
      async *stream(): AsyncGenerator<StreamEvent> {
        held += 1
        await gate.promise
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const build = async (conversationId: string) =>
      new Session({
        model: 'test-model',
        system: 'BASE',
        registry: createToolRegistry(),
        memory: new SqliteMemory({ dir }),
        store,
        scope: { gateway: 'cli', conversationId },
        record: (await store.load(record.id))!,
        cwd: process.cwd(),
        provider,
        maxSteps: 4,
      })

    const first = await build('first')
    const firstTurn = (async () => {
      for await (const _event of first.send('one')) {
        // drain
      }
    })()
    while (held < 1) await settle()

    // The reader stops the moment the wait is over — before the turn it was
    // waiting for has been handed over.
    const second = await build('second')
    const stopped = (async () => {
      for await (const event of second.send('two')) {
        if (event.type === 'waited') break
      }
    })()
    // It is sitting on the wait; letting the first turn finish is what ends it.
    await settle()
    gate.resolve()
    await stopped
    await firstTurn
    await settle()

    // The session is free again: the lease was not left behind by the frame that
    // took it and never handed it over.
    const lease = await store.tryAcquire(record.id)
    expect(lease).not.toBeNull()
    await lease!.release()
  })
})

describe('a session another writer summarized away', () => {
  it('reports the compaction, which adds no message and still takes turns off the screen', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const store = new FileSessionStore({ dir: path.join(dir, 'sessions') })
    const record = await store.create()
    const provider = new CapturingProvider()
    const session = new Session({
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new SqliteMemory({ dir }),
      store,
      scope: { gateway: 'cli', conversationId: 'summarized' },
      record,
      cwd: process.cwd(),
      provider,
      maxSteps: 4,
    })

    // The other writer summarized the older turns away.
    const other = (await store.load(record.id))!
    other.summary = 'the earlier turns, in short'
    other.droppedTokens = 120
    await store.save(other, other.version)

    const events: AgentEvent[] = []
    for await (const event of session.send('hello there')) events.push(event)

    // Nothing was added, and the context is still not what the screen shows.
    expect(events).toContainEqual({ type: 'rebased', added: 0, compacted: true })
  })
})

describe('a session deleted while it was open', () => {
  it('says it is gone instead of running a turn it could never save', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const store = new FileSessionStore({ dir: path.join(dir, 'sessions') })
    const record = await store.create()
    const provider = new CapturingProvider()
    const session = new Session({
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new SqliteMemory({ dir }),
      store,
      scope: { gateway: 'cli', conversationId: 'gone' },
      record,
      cwd: process.cwd(),
      provider,
      maxSteps: 4,
    })

    await store.remove(record.id)

    const events: AgentEvent[] = []
    for await (const event of session.send('hello there')) events.push(event)

    // Not a version conflict, which would read as somebody merely having changed
    // it, and not a turn whose transcript can never be written back.
    expect(events).toEqual([{ type: 'error', message: `session ${record.id} no longer exists` }])
    expect(await store.load(record.id)).toBeNull()
  })
})

describe('one turn per session', () => {
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('makes a second turn wait, then run on top of the first', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const store = new FileSessionStore({ dir: path.join(dir, 'sessions') })
    const record = await store.create()
    const gate = deferred()
    let started = 0
    const provider: Provider = {
      id: 'gated',
      async *stream(): AsyncGenerator<StreamEvent> {
        started += 1
        if (started === 1) {
          yield { type: 'text', delta: 'the first answer' }
          // Held open, so the second turn has to wait for this one to end.
          await gate.promise
          yield { type: 'done', finishReason: 'stop' }
          return
        }
        yield { type: 'text', delta: 'the second answer' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    const build = async (conversationId: string) =>
      new Session({
        model: 'test-model',
        system: 'BASE',
        registry: createToolRegistry(),
        memory: new SqliteMemory({ dir }),
        store,
        scope: { gateway: 'cli', conversationId },
        // Two turns over one store: a second terminal, or a daemon and a CLI.
        record: (await store.load(record.id))!,
        cwd: process.cwd(),
        provider,
        maxSteps: 4,
      })

    // Both open the session before either writes, as two terminals would.
    const first = await build('first')
    const second = await build('second')
    const events: AgentEvent[] = []
    const firstTurn = (async () => {
      for await (const event of first.send('one')) events.push(event)
    })()
    while (started < 1) await settle()

    const secondEvents: AgentEvent[] = []
    const secondTurn = (async () => {
      for await (const event of second.send('two')) secondEvents.push(event)
    })()
    await settle()

    // The second turn said it was waiting, and never reached the model.
    expect(secondEvents).toContainEqual({ type: 'waiting' })
    expect(started).toBe(1)

    gate.resolve()
    await firstTurn
    await secondTurn

    expect(started).toBe(2)
    // The second turn picked up what the first wrote before answering.
    expect(secondEvents).toContainEqual({ type: 'rebased', added: 2, compacted: false })
    // It waited, and the wait is bounded: announced before it started, over
    // before the turn was handed anything written elsewhere.
    const kinds = secondEvents.map((event) => event.type)
    expect(kinds.indexOf('waiting')).toBeLessThan(kinds.indexOf('waited'))
    expect(kinds.indexOf('waited')).toBeLessThan(kinds.indexOf('rebased'))
    const onDisk = (await store.load(record.id))!
    expect(onDisk.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'the first answer' },
      { type: 'text', text: 'two' },
      { type: 'text', text: 'the second answer' },
    ])
  })
})

describe('transcript version', () => {
  it('never repeats, even for writes that land in the same millisecond', async () => {
    const { session, record } = await run('hello')

    const versions = [record.updatedAt]
    await session.persist()
    versions.push(record.updatedAt)
    await session.persist()
    versions.push(record.updatedAt)

    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i]!).toBeGreaterThan(versions[i - 1]!)
    }
  })
})

describe('delegation to a subagent', () => {
  class ScriptedProvider implements Provider {
    readonly id = 'scripted'
    calls = 0
    constructor(private readonly scripts: StreamEvent[][]) {}

    async *stream(): AsyncGenerator<StreamEvent> {
      const script = this.scripts[this.calls] ?? [{ type: 'done', finishReason: 'stop' }]
      this.calls += 1
      for (const event of script) yield event
    }
  }

  async function delegate(provider: Provider) {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const store = new MemorySessionStore()
    const scope: MemoryScope = { gateway: 'cli', conversationId: 'task' }
    const record = await store.create()
    const session = new Session({
      model: 'test-model',
      system: 'BASE',
      registry: createToolRegistry(),
      memory: new SqliteMemory({ dir }),
      store,
      scope,
      record,
      cwd: process.cwd(),
      provider,
      maxSteps: 4,
    })

    const events: AgentEvent[] = []
    for await (const event of session.send('go')) events.push(event)
    return { events, onDisk: (await store.load(record.id))! }
  }

  it('runs the subtask in its own context and brings back only its report', async () => {
    const provider = new ScriptedProvider([
      // The parent delegates.
      [
        {
          type: 'tool-call',
          id: 'c1',
          name: 'task',
          args: { description: 'survey deps', prompt: 'read a and b, report the versions' },
        },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      // The subagent answers.
      [
        { type: 'text', delta: 'SUBAGENT REPORT' },
        { type: 'done', finishReason: 'stop' },
      ],
      // The parent answers.
      [
        { type: 'text', delta: 'FINAL' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])

    const { events, onDisk } = await delegate(provider)

    // One call for the parent's tool call, one for the subagent, one for the
    // parent's answer — the subtask is a separate loop, not a second turn.
    expect(provider.calls).toBe(3)

    const end = events.find(
      (event): event is Extract<AgentEvent, { type: 'tool-end' }> =>
        event.type === 'tool-end' && event.name === 'task',
    )
    expect(end?.result).toBe('SUBAGENT REPORT')

    // The parent's transcript carries the report and nothing else: whatever the
    // subagent read on the way never entered this conversation.
    expect(onDisk.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    const toolMessage = onDisk.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content[0]).toMatchObject({ content: 'SUBAGENT REPORT' })
  })
})
