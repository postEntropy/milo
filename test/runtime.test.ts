import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'
import { AgentRuntime, type RuntimeOptions } from '../src/core/runtime.js'
import { FileSessionStore } from '../src/core/sessions/file-store.js'
import { createToolRegistry } from '../src/core/tools/index.js'

class StubProvider implements Provider {
  readonly id = 'stub'
  calls = 0
  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', finishReason: 'stop' }
  }
}

function runtimeOptions(dir: string): RuntimeOptions {
  return {
    provider: new StubProvider(),
    model: 'm',
    system: 'BASE',
    registry: createToolRegistry(),
    memory: new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-mem-')) }),
    cwd: process.cwd(),
    store: new FileSessionStore({ dir }),
  }
}

const cli = { gateway: 'cli', conversationId: 'main' }

async function drain(promise: AsyncGenerator<unknown>): Promise<void> {
  for await (const _event of promise) {
    // drain
  }
}

describe('AgentRuntime sessions', () => {
  it('binds a conversation to one session and reuses it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    const again = await runtime.getSession(cli)

    expect(first.id).toBe(again.id)
    expect(runtime.sessionCount).toBe(1)
  })

  it('opens a conversation once per run, and a restart begins a new one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))

    // One run: the first message opens a conversation and the rest stay in it.
    const run = new AgentRuntime(runtimeOptions(dir))
    const opened = await run.sessionFor(cli)
    expect((await run.sessionFor(cli)).id).toBe(opened.id)

    // A restart is a second run over the same store: a new conversation, with the
    // one left behind still there to resume.
    const restarted = new AgentRuntime(runtimeOptions(dir))
    const afterRestart = await restarted.sessionFor(cli)
    expect(afterRestart.id).not.toBe(opened.id)
    expect((await restarted.listSessions()).some((entry) => entry.id === opened.id)).toBe(true)
  })

  it('starts a new session without losing the old one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    await drain(first.send('hello'))

    const second = await runtime.newSession(cli, 'my project')
    expect(second.id).not.toBe(first.id)
    expect(second.title).toBe('my project')

    const list = await runtime.listSessions()
    expect(list.map((entry) => entry.id)).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(list.find((entry) => entry.id === second.id)?.title).toBe('my project')
  })

  it('switches back to an old session with its transcript intact', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    await drain(first.send('remember this'))
    await runtime.newSession(cli)

    const back = await runtime.resumeSession(cli, first.id)
    expect(back?.id).toBe(first.id)
    expect(back?.messages.length).toBeGreaterThan(0)
  })

  it('keeps the resumed session when the scope is opened again in the same run', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    await drain(first.send('remember this'))
    await runtime.newSession(cli)

    await runtime.resumeSession(cli, first.id)
    // Opening the scope is not a reason to start over: a surface that resumes and
    // then opens it — the web, whose socket connects on the id it just minted —
    // has to land in the session it asked for.
    expect((await runtime.sessionFor(cli)).id).toBe(first.id)
  })

  it('returns null for an unknown session id', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))
    expect(await runtime.resumeSession(cli, 'nope-nope-9')).toBeNull()
  })

  it('continues the same session after a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))

    const before = new AgentRuntime(runtimeOptions(dir))
    const session = await before.getSession(cli)
    await drain(session.send('first message'))

    // A new process, same on-disk store.
    const after = new AgentRuntime(runtimeOptions(dir))
    const resumed = await after.getSession(cli)

    expect(resumed.id).toBe(session.id)
    expect(resumed.messages).toHaveLength(2)
  })

  it('lets another gateway open the same session', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const telegram = await runtime.getSession({ gateway: 'telegram', conversationId: '42' })
    await drain(telegram.send('from telegram'))

    const opened = await runtime.resumeSession(
      { gateway: 'discord', conversationId: '99' },
      telegram.id,
    )
    expect(opened?.id).toBe(telegram.id)

    const discord = await runtime.getSession({ gateway: 'discord', conversationId: '99' })
    expect(discord.id).toBe(telegram.id)
    expect(discord.messages.length).toBeGreaterThan(0)
  })
})

describe('AgentRuntime recaps', () => {
  it('recaps the session it leaves, so /sessions can say what it was about', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    await drain(first.send('a question worth remembering later'))
    await runtime.newSession(cli)
    await runtime.flush()

    const list = await runtime.listSessions()
    expect(list.find((entry) => entry.id === first.id)?.recap).toBe('ok')
  })

  it('does not hold up the new session while it recaps the old one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    let releaseDigest: () => void = () => {}
    const digestGate = new Promise<void>((resolve) => {
      releaseDigest = resolve
    })
    const provider: Provider = {
      id: 'gated',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        // The recap's own call is the one that carries no tool list; hold it open.
        if (!req.tools) await digestGate
        yield { type: 'text', delta: 'ok' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const runtime = new AgentRuntime({ ...runtimeOptions(dir), provider })

    const first = await runtime.getSession(cli)
    await drain(first.send('hello'))

    // The switch comes back while the recap is still in flight.
    const second = await runtime.newSession(cli)
    expect(second.id).not.toBe(first.id)
    const whileRecapping = await runtime.listSessions()
    expect(whileRecapping.find((entry) => entry.id === first.id)?.recap).toBeUndefined()

    releaseDigest()
    await runtime.flush()

    const after = await runtime.listSessions()
    expect(after.find((entry) => entry.id === first.id)?.recap).toBe('ok')
  })

  it('does not show a recap whose transcript moved on while it was being written', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    let releaseDigest: () => void = () => {}
    const digestGate = new Promise<void>((resolve) => {
      releaseDigest = resolve
    })
    const provider: Provider = {
      id: 'gated',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        if (!req.tools) await digestGate
        yield { type: 'text', delta: 'ok' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const runtime = new AgentRuntime({ ...runtimeOptions(dir), provider })

    const first = await runtime.getSession(cli)
    await drain(first.send('hello'))

    await runtime.newSession(cli) // the recap of `first` is now held at the gate
    const back = await runtime.resumeSession(cli, first.id)
    expect(back).not.toBeNull()
    await drain(back!.send('a second turn')) // the transcript moved on

    releaseDigest()
    await runtime.flush()

    const entry = (await runtime.listSessions()).find((item) => item.id === first.id)
    // The second turn is still there — a recap never touches the transcript —
    // and the recap of the older one is not shown as if it described this one.
    expect(entry?.messageCount).toBe(4)
    expect(entry?.recap).toBeUndefined()
  })

  it('leaves a session that was never used without a recap', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const runtime = new AgentRuntime(runtimeOptions(dir))

    const first = await runtime.getSession(cli)
    await runtime.newSession(cli)
    await runtime.flush()

    const list = await runtime.listSessions()
    expect(list.find((entry) => entry.id === first.id)?.recap).toBeUndefined()
  })

  it('does not redo a recap that is still fresh', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const provider = new StubProvider()
    const runtime = new AgentRuntime({ ...runtimeOptions(dir), provider })

    const first = await runtime.getSession(cli)
    await drain(first.send('hello'))
    await runtime.newSession(cli) // leaves `first`: it gets a recap
    await runtime.flush()
    await runtime.resumeSession(cli, first.id) // leaves the empty new session behind
    await runtime.flush()

    // Back on `first`, whose recap is still newer than its last turn.
    provider.calls = 0
    await runtime.newSession(cli)
    await runtime.flush()

    expect(provider.calls).toBe(0)
  })
})

describe('AgentRuntime model switch', () => {
  it('builds the provider again, so a session open across a switch runs on the new one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const used: string[] = []
    const providerFor = (model: string): Provider => ({
      id: model,
      async *stream(): AsyncGenerator<StreamEvent> {
        used.push(model)
        yield { type: 'text', delta: 'ok' }
        yield { type: 'done', finishReason: 'stop' }
      },
    })
    const runtime = new AgentRuntime({
      ...runtimeOptions(dir),
      provider: providerFor('deepseek/deepseek-v4-flash'),
      providerFor,
    })

    const session = await runtime.getSession(cli)
    await drain(session.send('first'))
    expect(used).toEqual(['deepseek/deepseek-v4-flash'])

    runtime.setModel('claude-sonnet-4-5')
    await drain(session.send('second'))

    // The session was opened before the switch, and `claude` resolves to the
    // other wire: the turn that follows has to run through the provider the new
    // model chose, not the one it was built with.
    expect(used).toEqual(['deepseek/deepseek-v4-flash', 'claude-sonnet-4-5'])
  })
})

describe('AgentRuntime close', () => {
  it('waits for the facts of a finished turn before closing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-rt-'))
    const memory = new SqliteMemory({ dir: mkdtempSync(path.join(tmpdir(), 'milo-mem-')) })
    let release: () => void = () => {}
    const extractionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    let call = 0
    const provider: Provider = {
      id: 'gated',
      async *stream(): AsyncGenerator<StreamEvent> {
        call += 1
        // The turn answers first; the extraction of what to keep from it is the
        // call after, and the one held open here.
        if (call > 1) await extractionGate
        yield { type: 'text', delta: call > 1 ? 'Meu editor e o Neovim.' : 'ok' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }
    const runtime = new AgentRuntime({ ...runtimeOptions(dir), provider, memory, derive: true })
    const session = await runtime.getSession(cli)
    await drain(session.send('qual editor eu uso?'))

    let closed = false
    const closing = runtime.close().then(() => {
      closed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    // Parked at the extraction: the way out is still waiting on it, because a
    // fact the turn decided to keep must not die with the process.
    expect(closed).toBe(false)

    release()
    await closing

    const notes = await session.memories()
    expect(notes.map((note) => note.text)).toContain('Meu editor e o Neovim.')
  })
})
