import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/core/config/schema.js'
import type { LoadedConfig } from '../src/core/config/load.js'
import type { AgentEvent } from '../src/core/agent/events.js'
import type { PermissionMode } from '../src/core/tools/permission.js'
import { runCommand, type RunRuntime, type RunSession } from '../src/bin/run.js'

/** A session that answers with the events the test gave it, and keeps what it was told. */
class FakeSession implements RunSession {
  readonly sent: string[] = []

  constructor(
    readonly id: string,
    private readonly events: AgentEvent[],
  ) {}

  async *send(input: string): AsyncGenerator<AgentEvent> {
    this.sent.push(input)
    for (const event of this.events) yield event
  }
}

interface Opened {
  project?: string
}

class FakeRuntime implements RunRuntime {
  readonly opened: Opened[] = []
  readonly resumed: string[] = []
  readonly permissionUpdates: { mode?: PermissionMode; allow?: string[] }[] = []
  continued = false
  closed = false

  permissions = {
    update: (options: { mode?: PermissionMode; allow?: string[] }) => {
      this.permissionUpdates.push(options)
    },
  }

  constructor(private readonly session: RunSession | null) {}

  async newSession(
    _scope: { gateway: string; conversationId: string },
    _title?: string,
    options?: Opened,
  ): Promise<RunSession> {
    this.opened.push(options ?? {})
    return this.session!
  }

  async resumeSession(
    _scope: { gateway: string; conversationId: string },
    id: string,
  ): Promise<RunSession | null> {
    this.resumed.push(id)
    return this.session
  }

  async getSession(): Promise<RunSession> {
    this.continued = true
    return this.session!
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function loaded(): LoadedConfig {
  const config = ConfigSchema.parse({
    provider: 'test',
    model: 'test-model',
    providers: { test: { baseURL: 'http://127.0.0.1:1/v1', wire: 'openai' } },
  })
  return {
    config,
    provider: { id: 'test', baseURL: 'http://127.0.0.1:1/v1', wire: 'openai', apiKey: false },
    model: 'test-model',
  }
}

function collector(): {
  out(text: string): void
  err(text: string): void
  text(): string
  errors(): string
} {
  const out: string[] = []
  const err: string[] = []
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    text: () => out.join(''),
    errors: () => err.join(''),
  }
}

const answer: AgentEvent[] = [
  { type: 'text-delta', delta: 'Hello' },
  { type: 'text-delta', delta: ' there' },
]

describe('milo run', () => {
  it('prints the answer and exits zero', async () => {
    const io = collector()
    const runtime = new FakeRuntime(new FakeSession('s1', answer))

    const code = await runCommand(['run', 'say hi'], io, { loaded: loaded(), runtime })

    expect(code).toBe(0)
    expect(io.text()).toBe('Hello there\n')
    expect(runtime.closed).toBe(true)
  })

  it('prints one JSON object per event with --json', async () => {
    const io = collector()
    const runtime = new FakeRuntime(new FakeSession('s1', answer))

    const code = await runCommand(['run', '--json', 'say hi'], io, { loaded: loaded(), runtime })

    expect(code).toBe(0)
    const lines = io.text().trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual(answer)
  })

  it('says a failed turn on stderr and exits one', async () => {
    const io = collector()
    const runtime = new FakeRuntime(
      new FakeSession('s1', [{ type: 'error', message: 'the provider refused' }]),
    )

    const code = await runCommand(['run', 'go'], io, { loaded: loaded(), runtime })

    expect(code).toBe(1)
    expect(io.errors()).toContain('the provider refused')
  })

  it('starts the session in the project it was given', async () => {
    const io = collector()
    const runtime = new FakeRuntime(new FakeSession('s1', answer))

    const code = await runCommand(['run', '--project', 'milo', 'go'], io, {
      loaded: loaded(),
      runtime,
      resolveProject: (ref) =>
        ref === 'milo' ? { id: 'calm-otter-7', name: 'milo', path: '/tmp/milo' } : undefined,
    })

    expect(code).toBe(0)
    expect(runtime.opened).toEqual([{ project: 'calm-otter-7' }])
  })

  it('refuses a project it does not know', async () => {
    const io = collector()
    const runtime = new FakeRuntime(new FakeSession('s1', answer))

    const code = await runCommand(['run', '--project', 'nope', 'go'], io, {
      loaded: loaded(),
      runtime,
      resolveProject: () => undefined,
    })

    expect(code).toBe(1)
    expect(io.errors()).toContain('No project "nope"')
    expect(runtime.opened).toEqual([])
  })

  it('continues a named session, and refuses one that is gone', async () => {
    const io = collector()
    const session = new FakeSession('s1', answer)
    const runtime = new FakeRuntime(session)

    expect(await runCommand(['run', '--session', 'calm-otter-7', 'go'], io, { loaded: loaded(), runtime })).toBe(0)
    expect(runtime.resumed).toEqual(['calm-otter-7'])

    const missing = new FakeRuntime(null)
    expect(await runCommand(['run', '--session', 'calm-otter-7', 'go'], io, { loaded: loaded(), runtime: missing })).toBe(1)
    expect(io.errors()).toContain('No session "calm-otter-7"')
  })

  it('picks up the session this conversation last used with --continue', async () => {
    const io = collector()
    const runtime = new FakeRuntime(new FakeSession('s1', answer))

    expect(await runCommand(['run', '--continue', 'go'], io, { loaded: loaded(), runtime })).toBe(0)
    expect(runtime.continued).toBe(true)
  })

  it('applies the mode and the tools it may use unattended', async () => {
    const io = collector()
    const runtime = new FakeRuntime(new FakeSession('s1', answer))

    await runCommand(['run', '--mode', 'auto', '--allow', 'shell_command,write_file', 'go'], io, {
      loaded: loaded(),
      runtime,
    })

    expect(runtime.permissionUpdates).toEqual([
      { mode: 'auto', allow: ['shell_command', 'write_file'] },
    ])
  })

  it('takes the prompt from stdin when none was given', async () => {
    const io = collector()
    const session = new FakeSession('s1', answer)
    const runtime = new FakeRuntime(session)

    const code = await runCommand(['run'], io, {
      loaded: loaded(),
      runtime,
      readStdin: async () => 'from the pipe',
    })

    expect(code).toBe(0)
    expect(session.sent).toEqual(['from the pipe'])
  })

  it('says there is nothing to do when there is no prompt at all', async () => {
    const io = collector()
    const runtime = new FakeRuntime(new FakeSession('s1', answer))

    const code = await runCommand(['run'], io, {
      loaded: loaded(),
      runtime,
      readStdin: async () => '',
    })

    expect(code).toBe(1)
    expect(io.errors()).toContain('Nothing to do')
  })
})

describe('milo run and the verification gate', () => {
  it('exits one when the checks failed, and keeps the answer on stdout', async () => {
    const io = collector()
    const runtime = new FakeRuntime(
      new FakeSession('s1', [
        { type: 'text-delta', delta: 'I changed it.' },
        {
          type: 'verification',
          result: {
            kind: 'checks',
            ok: false,
            checks: [
              { name: 'test', command: 'npm test', ok: false, exitCode: 1, timedOut: false, ms: 1, output: 'boom' },
            ],
          },
          text: 'Checks failed — 1 of 1.\ntest (npm test): exit 1\n  boom',
          ok: false,
        },
      ]),
    )

    const code = await runCommand(['run', 'change it'], io, { loaded: loaded(), runtime })

    expect(code).toBe(1)
    expect(io.text()).toBe('I changed it.\n')
    expect(io.errors()).toContain('Checks failed')
  })
})
