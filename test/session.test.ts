import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/core/agent/events.js'
import { FileMemory } from '../src/core/memory/local.js'
import type { MemoryScope } from '../src/core/memory/index.js'
import type {
  ChatRequest,
  Provider,
  ReasoningEffort,
  StreamEvent,
} from '../src/core/providers/types.js'
import type { HistoryEntry } from '../src/core/history.js'
import { Session, type SessionOptions } from '../src/core/session.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
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
  const memory = new FileMemory({ dir })
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
  const memory = new FileMemory({ dir })
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

  it('remembers the user message but not the assistant reply', async () => {
    const { memory, scope } = await run('my editor is Neovim')

    const userHits = await memory.recall(scope, 'which editor do I like?', { limit: 5 })
    expect(userHits.some((hit) => hit.text.includes('Neovim'))).toBe(true)

    const assistantHits = await memory.recall(scope, 'SECRET_ASSISTANT_REPLY', { limit: 5 })
    expect(assistantHits).toEqual([])
  })

  it('takes up a message sent mid-turn, and writes it down as it arrives', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const memory = new FileMemory({ dir })
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

    // What the user said is a durable fact whether it opened a turn or corrected one.
    const hits = await memory.recall(scope, 'config', { limit: 5 })
    expect(hits.some((hit) => hit.text.includes('~/.milo'))).toBe(true)
  })

  it('lets the model save a fact with the remember tool', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-session-'))
    const memory = new FileMemory({ dir })
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
    expect(stats.messages).toBe(session.messages.length)
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

    // A brand-new session for the same conversation is a /new: its transcript is
    // empty, but the scope — and therefore the memory — is the same.
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

    const { session, memory, scope } = await sessionWith(provider)
    controller.abort()

    const events: AgentEvent[] = []
    for await (const event of session.send('remember this', { signal: controller.signal })) {
      events.push(event)
    }

    expect(events.some((event) => event.type === 'aborted')).toBe(true)
    expect(events.some((event) => event.type === 'error')).toBe(false)
    // Nothing was answered, so nothing is kept.
    expect(await memory.recall(scope, 'remember this', { limit: 5 })).toEqual([])
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
