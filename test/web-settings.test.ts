import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Classifier } from '../src/core/classifier/index.js'
import type { McpServers } from '../src/core/mcp/servers.js'
import { stringify } from 'yaml'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-settings-'))
process.env.MILO_HOME = home

// A GitHub repository that holds two skills, so the picker branch is reachable
// off the network. Every other source resolves to one skill, as a local path does.
vi.mock('../src/core/skills/sources.js', () => ({
  resolveSource: async (
    source: string,
    options: { skill?: string },
  ): Promise<Array<{ name: string; description: string; markdown: string; origin: string }>> => {
    const solo = { name: 'solo', description: 'one skill', markdown: '---\nname: solo\ndescription: one skill\n---\n', origin: source }
    if (source !== 'multi/repo') return [solo]
    const both = [
      { name: 'one', description: 'first', markdown: '---\nname: one\ndescription: first\n---\n', origin: source },
      { name: 'two', description: 'second', markdown: '---\nname: two\ndescription: second\n---\n', origin: source },
    ]
    return options.skill ? both.filter((skill) => skill.name === options.skill) : both
  },
}))

const { WebSettings } = await import('../src/gateways/web/settings.js')
const { createMcpServers } = await import('../src/core/mcp/servers.js')
const { mcpFile } = await import('../src/core/config/paths.js')
const { AgentRuntime } = await import('../src/core/runtime.js')
const { saveAuth, readConfig } = await import('../src/core/config/load.js')
const { fileHistory } = await import('../src/core/history.js')

const CHAT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

afterEach(() => {
  // The tree is rebuilt rather than only removed: a later test writes into it.
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

function writeConfig(): void {
  writeFileSync(path.join(home, 'config.yml'), stringify({
    provider: 'test',
    model: 'test-model',
    providers: { test: { baseURL: 'https://provider.example/v1' } },
  }))
}

function build(
  memory: Record<string, unknown> = {},
  mcp: McpServers | null = null,
  classifier: Classifier | null = null,
): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider: { id: 'test', stream: async function* () {} },
    model: 'test-model',
    system: '',
    registry: { specs: () => [] } as never,
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
      ...memory,
    } as never,
    cwd: home,
    mcp,
    classifier,
  })
}

/** A runtime that can move between providers, like the one bootstrap wires. */
function buildSwitchable(): InstanceType<typeof AgentRuntime> {
  const active = { id: 'test' }
  return new AgentRuntime({
    provider: { id: 'test', stream: async function* () {} },
    providerFor: () => ({ id: active.id, stream: async function* () {} }),
    providerSwitch: { use: (id) => { active.id = id; return true }, name: (id) => id },
    model: 'test-model',
    system: '',
    registry: { specs: () => [] } as never,
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    cwd: home,
  })
}

/**
 * A runtime where a model names its own provider, the way a real boot resolves
 * the pair from disk — which is what `set-model` has to write back.
 */
function buildModelAware(): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider: { id: 'test', stream: async function* () {} },
    providerFor: (model: string) => ({
      id: model.startsWith('other/') ? 'other' : 'test',
      stream: async function* () {},
    }),
    model: 'test-model',
    system: '',
    registry: { specs: () => [] } as never,
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    cwd: home,
  })
}

/** A runtime whose model answers with `answer`, for the mail assistant. */
function buildModel(answer: string): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    provider: {
      id: 'test',
      stream: async function* () {
        yield { type: 'text', delta: answer }
      },
    },
    model: 'test-model',
    system: '',
    registry: { specs: () => [] } as never,
    memory: {
      remember: async () => undefined,
      recall: async () => [],
      list: async () => [],
      forget: async () => false,
    } as never,
    cwd: home,
  })
}

/** Two configured providers, each with a key, so a switch has somewhere to go. */
function writeTwoProviders(): void {
  writeFileSync(path.join(home, 'config.yml'), stringify({
    provider: 'test',
    model: 'test-model',
    providers: {
      test: { baseURL: 'https://provider.example/v1' },
      other: { name: 'Other', baseURL: 'https://other.example/v1' },
    },
  }))
  saveAuth({ providers: { test: 'k1', other: 'k2' }, gateways: {}, search: {} })
}

/** A note as the store returns it, for the tests that list and forget one. */
const NOTE = { id: '11111111-2222-3333-4444-555555555555', text: 'prefers tabs', createdAt: 1_700_000_000_000 }

describe('web Settings secret handling', () => {
  it('never returns API keys or custom headers in overview', async () => {
    writeFileSync(path.join(home, 'config.yml'), stringify({
      provider: 'test',
      model: 'test-model',
      providers: { test: { baseURL: 'https://provider.example/v1', headers: { authorization: 'Bearer header-secret' } } },
    }))
    saveAuth({ providers: { test: 'provider-secret' }, gateways: {}, search: {} })
    const settings = new WebSettings(build({}), home)
    const overview = JSON.stringify(await settings.handle('overview'))
    expect(overview).not.toContain('provider-secret')
    expect(overview).not.toContain('header-secret')
    expect(overview).toContain('••••••••••••••••')
  })

  it('reports the Google grant, and never the secret inside it', async () => {
    writeConfig()
    saveAuth({
      providers: {},
      gateways: {},
      search: {},
      google: {
        clientId: 'client-id-123',
        clientSecret: 'client-secret-456',
        refreshToken: 'refresh-token-789',
        email: 'ana@exemplo',
        connectedAt: '2026-09-30T12:00:00.000Z',
      },
    })
    const settings = new WebSettings(build({}), home)
    const raw = JSON.stringify(await settings.handle('overview'))
    expect(raw).not.toContain('client-secret-456')
    expect(raw).not.toContain('refresh-token-789')

    const overview = (await settings.handle('overview')) as {
      google: { kind: string; email?: string; tools: string[] }
    }
    expect(overview.google.kind).toBe('connected')
    expect(overview.google.email).toBe('ana@exemplo')
    expect(overview.google.tools).toEqual([
      'gmail_search',
      'gmail_read',
      'drive_search',
      'drive_read',
    ])
  })

  it('says the Google tools are off when the config never asked for them', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    const overview = (await settings.handle('overview')) as { google: { kind: string } }
    expect(overview.google.kind).toBe('off')
  })

  it('says Google is wanted when the config asks and no account has answered', async () => {
    writeFileSync(path.join(home, 'config.yml'), stringify({
      provider: 'test',
      model: 'test-model',
      providers: { test: { baseURL: 'https://provider.example/v1' } },
      google: { enabled: true },
    }))
    const settings = new WebSettings(build({}), home)
    const overview = (await settings.handle('overview')) as { google: { kind: string } }
    expect(overview.google.kind).toBe('wanted')
  })

  it('reports the live model and effort, not the effort twice', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    const overview = await settings.handle('overview') as { live: { model: string; effort: string } }
    expect(overview.live.model).toBe('test-model')
    expect(overview.live.effort).toBe('medium')
  })
})

describe('web Settings memory notes', () => {
  it('lists the notes and forgets one', async () => {
    writeConfig()
    const forgotten: string[] = []
    const settings = new WebSettings(build({
      list: async () => [NOTE],
      forget: async (_scope: unknown, id: string) => { forgotten.push(id); return true },
    }), home)

    const listed = await settings.handle('memory-notes') as { notes: typeof NOTE[] }
    expect(listed.notes.map((note) => note.text)).toEqual(['prefers tabs'])

    const result = await settings.handle('forget-note', { id: NOTE.id })
    expect(result).toEqual({ removed: true })
    expect(forgotten).toEqual([NOTE.id])
    await expect(settings.handle('forget-note', {})).rejects.toThrow('note id')
  })
})

describe('web Settings routines', () => {
  it('creates, lists, pauses and removes one, targeting the web chat', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)

    const created = await settings.handle('routine-add', {
      prompt: 'look at the repo and tell me what moved',
      every: '2h',
      target: { gateway: 'web', chatId: CHAT },
    }) as { routine: { id: string; name: string } }
    // Unnamed at creation, so it takes the prompt's own first words — as a name reads.
    expect(created.routine.name).toBe('Look at the repo and tell me what moved')

    type View = { id: string; whenLabel: string; targetLabel: string; enabled: boolean; nextRunAt: number | null }
    let listed = await settings.handle('routines') as View[]
    expect(listed).toHaveLength(1)
    expect(listed[0]!.whenLabel).toBe('every 2h')
    expect(listed[0]!.targetLabel).toBe(`web:${CHAT}`)
    expect(listed[0]!.nextRunAt).toBeGreaterThan(Date.now())

    // It is the same file the timer reads, so `milo routines` sees it too.
    const onDisk = JSON.parse(readFileSync(path.join(home, 'routines.json'), 'utf8'))
    expect(onDisk[0].target).toEqual({ gateway: 'web', chatId: CHAT })

    await settings.handle('routine-enable', { id: created.routine.id, enabled: false })
    listed = await settings.handle('routines') as View[]
    expect(listed[0]!.enabled).toBe(false)
    expect(listed[0]!.nextRunAt).toBeNull()

    expect(await settings.handle('routine-remove', { id: created.routine.id })).toEqual({ removed: true })
    expect(await settings.handle('routines')).toEqual([])
  })

  it('carries the ceiling, and reads a routine that ran out as finished with nothing next', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    await settings.handle('routine-add', {
      prompt: 'ping',
      every: '2h',
      target: { gateway: 'web', chatId: CHAT },
    })

    // What the timer leaves when the last allowed run happens: the count is in the file
    // and the routine is off — the same file the daemon reads and writes.
    const file = path.join(home, 'routines.json')
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    writeFileSync(file, JSON.stringify(onDisk.map((entry) => ({ ...entry, limit: 2, runs: 2, enabled: false }))))

    type View = { whenLabel: string; finished: boolean; nextRunAt: number | null; nextRuns: number[] }
    const listed = await settings.handle('routines') as View[]

    expect(listed[0]!.whenLabel).toBe('every 2h, 2 runs')
    // Nothing next, so a phone reminding on the projected times is not told to remind
    // for a routine that will never fire again.
    expect(listed[0]).toMatchObject({ finished: true, nextRunAt: null, nextRuns: [] })
  })

  it('refuses a destination that is not a surface', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    await expect(settings.handle('routine-add', {
      prompt: 'x',
      every: '2h',
      target: { gateway: 'carrier-pigeon', chatId: '1' },
    })).rejects.toThrow('destination')
    await expect(settings.handle('routine-add', { prompt: 'x', every: '2h' })).rejects.toThrow('destination')
    await expect(settings.handle('routine-add', { prompt: 'x', target: { gateway: 'web', chatId: '1' } }))
      .rejects.toThrow('Set a time')
  })

  it('runs one now and answers with what it said, and with the run it made', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    const created = await settings.handle('routine-add', {
      prompt: 'say nothing',
      every: '6h',
      target: { gateway: 'web', chatId: CHAT },
    }) as { routine: { id: string } }

    // The fake provider streams nothing, so the run succeeds with an empty answer.
    const result = await settings.handle('routine-run', { id: created.routine.id }) as { runId: string; answer: string; failure: string | null }
    expect(result).toMatchObject({ answer: '', failure: null })
    // The id names the run the surface then reads, so it has to be a real one.
    expect(result.runId).toBeTruthy()
    expect((await settings.handle('routine-runs', { id: created.routine.id }) as { runs: { id: string }[] }).runs)
      .toEqual([expect.objectContaining({ id: result.runId })])

    await expect(settings.handle('routine-run', { id: 'no-such-routine' })).rejects.toThrow('No routine')
  })
})

describe('web Settings sessions', () => {
  it('starts a work session in plan mode when the project page asks for it', async () => {
    writeConfig()
    const runtime = build({})
    const settings = new WebSettings(runtime, home)
    const scope = { gateway: 'web', chatId: CHAT }

    const planned = await settings.handle('new-session', { chatId: CHAT, plan: true }) as { id: string }
    const planning = await runtime.getSession(scope)
    expect(planning.id).toBe(planned.id)
    expect(planning.planMode).toBe(true)

    // The ordinary start is Build: nothing turns plan mode on by accident.
    const plain = await settings.handle('new-session', { chatId: CHAT }) as { id: string }
    const building = await runtime.getSession(scope)
    expect(building.id).toBe(plain.id)
    expect(building.planMode).toBe(false)
  })

  it('deletes a saved session but refuses the one being looked at', async () => {
    writeConfig()
    const runtime = build({})
    const settings = new WebSettings(runtime, home)

    const session = await runtime.newSession({ gateway: 'web', chatId: CHAT })
    await expect(settings.handle('session-delete', { id: session.id, current: session.id }))
      .rejects.toThrow('session you are in')

    expect(await settings.handle('session-delete', { id: session.id, current: 'other-otter-1' }))
      .toEqual({ removed: true })
    expect((await settings.handle('sessions') as Array<{ id: string }>).some((item) => item.id === session.id)).toBe(false)
    await expect(settings.handle('session-delete', { id: session.id })).rejects.toThrow('not found')
  })

  it('reads where a session left off, for the card a long press lifts', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    const id = 'peek-otter-7'
    fileHistory.append([
      { at: '2026-10-18T20:00:00.000Z', session: id, scope: 'web:peek', kind: 'user', text: 'the first thing' },
      { at: '2026-10-18T20:01:00.000Z', session: id, scope: 'web:peek', kind: 'assistant', text: 'the first answer' },
      { at: '2026-10-18T20:02:00.000Z', session: id, scope: 'web:peek', kind: 'user', text: 'the last thing' },
    ])

    expect(await settings.handle('session-peek', { id })).toEqual([
      { who: 'you', text: 'the first thing' },
      { who: 'milo', text: 'the first answer' },
      { who: 'you', text: 'the last thing' },
    ])

    // A read and nothing else: a session the log never heard of is an empty card rather
    // than a failure, and an id that is not one is refused as such.
    expect(await settings.handle('session-peek', { id: 'peek-goose-9' })).toEqual([])
    await expect(settings.handle('session-peek', {})).rejects.toThrow('Invalid session id')
  })

  it('renames a saved session', async () => {
    writeConfig()
    const runtime = build({})
    const settings = new WebSettings(runtime, home)

    const session = await runtime.newSession({ gateway: 'web', chatId: CHAT })
    expect(await settings.handle('session-rename', { id: session.id, title: 'My Project' }))
      .toEqual({ renamed: true, id: session.id, title: 'My Project' })

    const list = await settings.handle('sessions') as Array<{ id: string; title?: string }>
    expect(list.find((item) => item.id === session.id)?.title).toBe('My Project')
  })
})

describe('web Settings skills', () => {
  it('installs one skill, and asks which one when the source holds several', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)

    expect(await settings.handle('install-skill', { source: 'local/skill' }))
      .toMatchObject({ installed: 'solo' })
    expect(readFileSync(path.join(home, 'skills', 'solo', 'SKILL.md'), 'utf8')).toContain('one skill')

    // Several skills are not guessed at: the names come back for the person to pick.
    expect(await settings.handle('install-skill', { source: 'multi/repo' })).toEqual({ needChoice: ['one', 'two'] })
    expect(await settings.handle('install-skill', { source: 'multi/repo', skill: 'two' }))
      .toMatchObject({ installed: 'two' })
    expect(readFileSync(path.join(home, 'skills', 'two', 'SKILL.md'), 'utf8')).toContain('second')
  })
})

describe('web Settings jobs', () => {
  it('reports progress through the registry and refuses what it cannot run', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)

    await expect(settings.handle('job-start', { kind: 'make-coffee' })).rejects.toThrow('Unknown job kind')
    await expect(settings.handle('job-start', { kind: 'profile-copy', id: '../escape', dir: '/tmp' }))
      .rejects.toThrow('Invalid browser id')
    await expect(settings.handle('job-start', { kind: 'profile-copy', id: 'chromium' })).rejects.toThrow('profile directory')
    await expect(settings.handle('job-status', { id: 'nope' })).rejects.toThrow('No such job')
  })
})

describe('web Settings config', () => {
  it('keeps the web section and its own address through a save', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    const before = await settings.handle('overview') as { config: Record<string, unknown> }
    // The defaults are there even though the file never mentioned them.
    expect(before.config.web).toEqual({ enabled: true, host: '127.0.0.1', port: 7717 })

    const next = { ...before.config, web: { enabled: true, host: '0.0.0.0', port: 8123 } }
    await settings.handle('save-config', { config: next })
    expect(readConfig()?.web).toEqual({ enabled: true, host: '0.0.0.0', port: 8123 })
  })

  it('keeps the keys of a nested section a patch only partly sends', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    const before = await settings.handle('overview') as { config: Record<string, unknown> }
    const permissions = before.config.permissions as Record<string, unknown>

    // A nested section written whole, with values away from the defaults.
    await settings.handle('save-config', {
      config: { permissions: { ...permissions, allow: ['gmail_modify'], deny: ['shell_command'], jevThreshold: 0.5 } },
    })
    // Now a patch that mentions only the mode: the siblings must survive it
    // rather than reset to the schema's defaults on the way through.
    await settings.handle('save-config', { config: { permissions: { mode: 'yolo' } } })

    expect(readConfig()?.permissions).toMatchObject({
      mode: 'yolo',
      allow: ['gmail_modify'],
      deny: ['shell_command'],
      jevThreshold: 0.5,
    })
  })

  it('clears an optional key when a patch sends null for it', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)

    await settings.handle('save-config', {
      config: {
        search: { provider: 'tavily' },
        memory: { recallLimit: 12, derive: false, embedding: { provider: 'openrouter' } },
      },
    })
    expect(readConfig()?.search).toEqual({ provider: 'tavily' })
    expect(readConfig()?.memory).toEqual({
      recallLimit: 12,
      derive: false,
      prune: true,
      embedding: { provider: 'openrouter' },
    })

    await settings.handle('save-config', {
      config: {
        search: null,
        memory: { recallLimit: null, embedding: null },
      },
    })
    expect(readConfig()?.search).toBeUndefined()
    expect(readConfig()?.memory).toEqual({ derive: false, prune: true })
  })

  it('moves the running model on a save', async () => {
    writeConfig()
    const runtime = build({})
    const settings = new WebSettings(runtime, home)
    const before = await settings.handle('overview') as { config: Record<string, unknown> }

    await settings.handle('save-config', { config: { ...before.config, model: 'another-model' } })

    expect(runtime.model).toBe('another-model')
    expect(readConfig()?.model).toBe('another-model')
  })

  it('writes the provider with the model, because the model implies it', async () => {
    writeTwoProviders()
    const runtime = buildModelAware()
    const settings = new WebSettings(runtime, home)

    await settings.handle('set-model', { model: 'other/model-x' })

    // The model resolved to the other provider, so the pair is written down
    // together: the model alone would leave the file claiming a provider that
    // does not serve it, and the next start would build the wrong one.
    expect(runtime.provider.id).toBe('other')
    expect(readConfig()?.model).toBe('other/model-x')
    expect(readConfig()?.provider).toBe('other')
  })

  it('sets reasoning effort on runtime and persists to config', async () => {
    writeConfig()
    const runtime = build({})
    const settings = new WebSettings(runtime, home)

    expect(await settings.handle('set-effort', { effort: 'high' })).toEqual({ effort: 'high' })
    expect(runtime.reasoningEffort).toBe('high')
    expect(readConfig()?.reasoningEffort).toBe('high')

    await expect(settings.handle('set-effort', { effort: 'invalid' })).rejects.toThrow('Reasoning effort must be low, medium or high.')
  })

  it('hands a saved session rule to the sessions after it, with no restart', async () => {
    writeConfig()
    const runtime = buildModel('Folding transcripts')
    const settings = new WebSettings(runtime, home)
    const before = await settings.handle('overview') as { config: { sessions: Record<string, unknown> } }

    await settings.handle('save-config', {
      config: { sessions: { ...before.config.sessions, titleModel: 'cheap-model' } },
    })

    expect(readConfig()?.sessions.titleModel).toBe('cheap-model')

    // A session started after the save is named by the rule just written, without
    // the process being restarted.
    const session = await runtime.newSession({ gateway: 'web', chatId: CHAT })
    for await (const _event of session.send('how do I fold a transcript?')) {
      // drain
    }
    await session.settle()

    expect(session.title).toBe('Folding transcripts')
  })
})

describe('web provider switching', () => {
  it('offers only the providers that have a key', async () => {
    writeTwoProviders()
    saveAuth({ providers: { test: 'k1' }, gateways: {}, search: {} })
    const settings = new WebSettings(build({}), home)
    expect(await settings.handle('providers')).toEqual([{ id: 'test', name: 'test' }])
  })

  it('switches the runtime live and writes provider and model down', async () => {
    writeTwoProviders()
    const runtime = buildSwitchable()
    const settings = new WebSettings(runtime, home)

    const result = await settings.handle('set-provider', { provider: 'other' }) as { provider: string; providerName: string; model: string }

    expect(runtime.provider.id).toBe('other')
    expect(result).toEqual({ provider: 'other', providerName: 'other', model: runtime.model })
    expect(readConfig()?.provider).toBe('other')
    expect(readConfig()?.model).toBe(runtime.model)
  })

  it('refuses a provider without a key, and leaves the runtime alone', async () => {
    writeTwoProviders()
    saveAuth({ providers: { test: 'k1' }, gateways: {}, search: {} })
    const runtime = buildSwitchable()
    const settings = new WebSettings(runtime, home)

    await expect(settings.handle('set-provider', { provider: 'other' })).rejects.toThrow(/no key|not configured/)
    expect(runtime.provider.id).toBe('test')
  })

  it('projects the model labels, so a client that cannot import them reads the same words', async () => {
    writeFileSync(path.join(home, 'config.yml'), stringify({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4.1-flash',
      providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
    }))
    const settings = new WebSettings(build({}), home)

    const models = await settings.handle('models', { provider: 'commandcode' }) as { id: string; label: string }[]

    expect(models.length).toBeGreaterThan(0)
    // The short name drops the vendor prefix, and the full id rides along: the
    // phone draws the label, `/model` still takes the id.
    const prefixed = models.find((model) => model.id.includes('/'))
    expect(prefixed).toBeDefined()
    expect(prefixed?.label).toBe(prefixed?.id.slice(prefixed.id.lastIndexOf('/') + 1))
  })
})

async function until(condition: () => boolean, ms = 4_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the condition never became true')
}

describe('web Settings MCP servers', () => {
  const writeMcp = (servers: Record<string, unknown>): void => {
    writeFileSync(mcpFile(), JSON.stringify({ servers }, null, 2))
  }

  it('reports the servers the file names, and the file itself', async () => {
    writeConfig()
    writeMcp({ notes: { command: 'node', args: ['notes.js'] }, off: { command: 'npx', enabled: false } })
    const settings = new WebSettings(build({}, createMcpServers(home)), home)
    const overview = (await settings.handle('overview')) as {
      mcp: { file: string; servers: Array<{ name: string; command: string; enabled: boolean }> }
    }
    expect(overview.mcp.file).toBe(mcpFile())
    expect(overview.mcp.servers).toEqual([
      { name: 'notes', command: 'node notes.js', enabled: true, state: 'idle', tools: 0, readOnly: [] },
      { name: 'off', command: 'npx', enabled: false, state: 'idle', tools: 0, readOnly: [] },
    ])
  })

  it('turns a server off in the file from the screen, and answers with the new state', async () => {
    writeConfig()
    writeMcp({ notes: { command: 'node' } })
    const settings = new WebSettings(build({}, createMcpServers(home)), home)
    const result = (await settings.handle('mcp-toggle', { name: 'notes', enabled: false })) as {
      servers: Array<{ enabled: boolean }>
    }
    expect(result.servers[0]?.enabled).toBe(false)
    const written = JSON.parse(readFileSync(mcpFile(), 'utf8')) as { servers: Record<string, { enabled: boolean }> }
    expect(written.servers.notes?.enabled).toBe(false)
  })

  it('reads the file again, so a server added by hand arrives without a restart', async () => {
    writeConfig()
    const entry = (env: Record<string, string>) => ({
      command: process.execPath,
      args: [path.join(process.cwd(), 'test', 'fixtures', 'mcp-server.mjs')],
      env,
    })
    writeMcp({ one: entry({ MCP_TOOLS: JSON.stringify([{ name: 'first', description: 'One tool.' }]) }) })
    const manager = createMcpServers(home)
    const settings = new WebSettings(build({}, manager), home)
    try {
      writeMcp({
        one: entry({ MCP_TOOLS: JSON.stringify([{ name: 'first', description: 'One tool.' }]) }),
        two: entry({ MCP_TOOLS: JSON.stringify([{ name: 'a' }, { name: 'b' }, { name: 'c' }]) }),
      })
      const result = (await settings.handle('mcp-reload')) as { servers: Array<{ name: string }> }
      // Reading the file is immediate; connecting is the background warm, so the
      // new server is listed at once and ready a moment later.
      expect(result.servers.map((server) => server.name)).toEqual(['one', 'two'])
      await until(() => manager.status().some((server) => server.name === 'two' && server.tools === 3))
    } finally {
      await manager.close()
    }
  })

  it('reports a config it cannot read instead of an empty list', async () => {
    writeConfig()
    writeFileSync(mcpFile(), '{ "servers": { "notes": { "command": "node", "comand": "typo" } } }')
    const settings = new WebSettings(build({}, createMcpServers(home)), home)
    const overview = (await settings.handle('overview')) as { mcp: { error?: string; servers: unknown[] } }
    expect(overview.mcp.error).toMatch(/has no field named "comand"/)
    expect(overview.mcp.servers).toEqual([])
  })
})

describe('web Settings mail', () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const grantAt = (access: string): void => {
    saveAuth({
      providers: {},
      gateways: {},
      search: {},
      google: { clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt', email: 'ana@exemplo', access: access as never },
    })
  }

  /** Gmail behind a stubbed fetch: the token refresh is answered, the rest is handed on. */
  const gmail = (handler: (url: string, init?: RequestInit) => Response): void => {
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 })
      return handler(url, init)
    })
  }

  afterEach(() => vi.unstubAllGlobals())

  it('reports the grant and the levels it could have been made at', async () => {
    writeConfig()
    grantAt('modify')
    const settings = new WebSettings(build({}), home)
    const status = (await settings.handle('email-status')) as { kind: string; access: string; tiers: { id: string }[]; filters: { id: string }[] }
    expect(status.kind).toBe('connected')
    expect(status.access).toBe('modify')
    expect(status.tiers.map((tier) => tier.id)).toEqual(['none', 'modify', 'compose', 'send'])
    expect(status.filters.map((filter) => filter.id)).toEqual(['unread', 'starred'])
  })

  it('lists the inbox through the grant', async () => {
    writeConfig()
    grantAt('none')
    const asked: string[] = []
    gmail((url) => {
      asked.push(url)
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1', threadId: 't1' }], nextPageToken: 'cursor' })
      return json({
        id: 'm1',
        threadId: 't1',
        payload: { headers: [{ name: 'From', value: 'ana@exemplo' }, { name: 'Subject', value: 'a nota' }] },
      })
    })

    const settings = new WebSettings(build({}), home)
    const page = (await settings.handle('email-inbox', { limit: 5 })) as {
      messages: { subject?: string }[]
      nextPageToken?: string
    }
    expect(page.nextPageToken).toBe('cursor')
    expect(page.messages[0]?.subject).toBe('a nota')
    expect(decodeURIComponent(asked.join('\n')).replace(/\+/g, ' ')).toContain('in:inbox')
  })

  it('refuses a send the grant does not cover, saying how to widen it', async () => {
    writeConfig()
    grantAt('compose')
    gmail(() => json({}))
    const settings = new WebSettings(build({}), home)
    await expect(settings.handle('email-send', { draft: { to: 'a@b', subject: 's', body: 'x' } }))
      .rejects.toThrow('--access send')
  })

  it('sends at the send level, with the message as RFC 822', async () => {
    writeConfig()
    grantAt('send')
    let raw = ''
    gmail((url, init) => {
      if (url.includes('/messages/send')) {
        raw = JSON.parse(String(init?.body ?? '{}')).raw
        return json({ id: 'm9' })
      }
      return json({})
    })

    const settings = new WebSettings(build({}), home)
    const sent = (await settings.handle('email-send', {
      draft: { to: 'ana@exemplo', subject: 'oi', body: 'texto' },
    })) as { id: string }
    expect(sent.id).toBe('m9')
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain('To: ana@exemplo')
  })

  it('answers an unknown mail action with the ones it knows', async () => {
    writeConfig()
    grantAt('modify')
    const settings = new WebSettings(build({}), home)
    await expect(settings.handle('email-modify', { id: 'm1', op: 'delete' })).rejects.toThrow(/archive/)
  })

  it('bins a message through the grant, over messages/trash', async () => {
    writeConfig()
    grantAt('modify')
    let asked = ''
    gmail((url, init) => {
      asked = `${init?.method ?? 'GET'} ${url}`
      return json({ id: 'm1' })
    })

    const settings = new WebSettings(build({}), home)
    const result = (await settings.handle('email-modify', { id: 'm1', op: 'trash' })) as { done: string }
    // The wording the core owns, the same one the agent's tool answers with.
    expect(result.done).toBe('Moved m1 to the bin.')
    expect(asked).toContain('POST')
    expect(asked).toContain('/messages/m1/trash')
  })

  it('refuses an id that is not one', async () => {
    writeConfig()
    grantAt('modify')
    const settings = new WebSettings(build({}), home)
    await expect(settings.handle('email-message', { id: '../../etc/passwd' })).rejects.toThrow('Invalid mail id')
  })

  it('summarizes a thread through the model, over mail it fetched itself', async () => {
    writeConfig()
    grantAt('none')
    gmail((url) => {
      if (url.includes('/threads/')) {
        return json({
          id: 't1',
          messages: [{
            id: 'm1',
            threadId: 't1',
            payload: {
              mimeType: 'text/plain',
              headers: [{ name: 'Subject', value: 'a nota' }],
              body: { data: Buffer.from('oi, tudo bem?').toString('base64url') },
            },
          }],
        })
      }
      return json({})
    })
    const settings = new WebSettings(buildModel('It asks how you are.'), home)
    const result = (await settings.handle('email-assist', { mode: 'summarize', threadId: 't1' })) as { text: string }
    expect(result.text).toBe('It asks how you are.')
  })

  it('summarizes the unread mail', async () => {
    writeConfig()
    grantAt('none')
    gmail((url) => {
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1', threadId: 't1' }] })
      if (url.includes('/messages/m1')) {
        return json({ id: 'm1', threadId: 't1', payload: { headers: [{ name: 'From', value: 'ana@exemplo' }, { name: 'Subject', value: 'a nota' }] } })
      }
      return json({})
    })
    const settings = new WebSettings(buildModel('Answer Ana.'), home)
    const result = (await settings.handle('email-assist', { mode: 'summarize-unread' })) as { text: string }
    expect(result.text).toBe('Answer Ana.')
  })

  it('answers an unknown assistance with the ones it knows', async () => {
    writeConfig()
    grantAt('none')
    const settings = new WebSettings(build({}), home)
    await expect(settings.handle('email-assist', { mode: 'translate' })).rejects.toThrow(/summarize-unread/)
  })

  /** A stand-in for the decision model: one answer per message id. */
  const classifierOf = (answers: Record<string, { choice: string; confidence?: number }>): Classifier =>
    ({ ask: async () => answers }) as unknown as Classifier

  /** The inbox behind a stubbed Gmail: one message, `m1`. */
  const oneMessage = (): void => gmail((url) => {
    if (url.includes('/messages?')) return json({ messages: [{ id: 'm1', threadId: 't1' }] })
    if (url.includes('/messages/m1')) {
      return json({ id: 'm1', threadId: 't1', payload: { headers: [{ name: 'From', value: 'ana@exemplo' }, { name: 'Subject', value: 'a nota' }] } })
    }
    return json({})
  })

  /** The row the inbox handed back, as the screen sends it to `email-sort`. */
  const row = { id: 'm1', threadId: 't1', from: 'ana@exemplo', subject: 'a nota' }

  it('draws the inbox without asking the classifier, and names what is left to sort', async () => {
    writeConfig()
    grantAt('none')
    oneMessage()
    let asked = 0
    const classifier = { ask: async () => { asked += 1; return {} } } as unknown as Classifier
    const settings = new WebSettings(build({}, null, classifier), home)

    const page = (await settings.handle('email-inbox', { limit: 5 })) as {
      messages: { labels: unknown[] }[]
      unsorted: string[]
    }
    // The mail is on screen and the classifier was never on the path to it.
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]?.labels).toEqual([])
    expect(page.unsorted).toEqual(['m1'])
    expect(asked).toBe(0)
  })

  it('sorts the rows the inbox could not place, materialising the label they fall into', async () => {
    writeConfig()
    grantAt('none')
    oneMessage()
    const settings = new WebSettings(build({}, null, classifierOf({ m1: { choice: 'receipt', confidence: 0.9 } })), home)

    const sorted = (await settings.handle('email-sort', { messages: [row] })) as {
      byMessage: Record<string, { id: string; name: string }[]>
      labels: { id: string }[]
    }
    expect(sorted.byMessage.m1).toEqual([expect.objectContaining({ id: 'receipt', name: 'Receipts' })])
    expect(sorted.labels.map((label) => label.id)).toContain('receipt')

    // The assignment is on disk, so the next inbox read carries it and has nothing left to sort.
    const page = (await settings.handle('email-inbox', { limit: 5 })) as {
      messages: { labels: { id: string }[] }[]
      unsorted: string[]
    }
    expect(page.messages[0]?.labels).toEqual([expect.objectContaining({ id: 'receipt', name: 'Receipts' })])
    expect(page.unsorted).toEqual([])
  })

  it('narrows the inbox by a quick filter and a search term, in one call', async () => {
    writeConfig()
    grantAt('none')
    const asked: string[] = []
    gmail((url) => {
      asked.push(url)
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1', threadId: 't1' }] })
      return json({ id: 'm1', threadId: 't1', payload: { headers: [{ name: 'Subject', value: 'a nota' }] } })
    })

    const settings = new WebSettings(build({}), home)
    await settings.handle('email-inbox', { filter: 'unread', search: 'from:ana' })
    // The query Gmail was handed carries both narrowings, and only one list was asked for.
    const listed = asked.filter((url) => url.includes('/messages?'))
    expect(listed).toHaveLength(1)
    expect(new URL(listed[0]!).searchParams.get('q')).toBe('in:inbox is:unread from:ana')
  })

  it('answers an unknown inbox filter with the ones it knows', async () => {
    writeConfig()
    grantAt('none')
    const settings = new WebSettings(build({}), home)
    await expect(settings.handle('email-inbox', { filter: 'important' })).rejects.toThrow(/unread/)
  })

  it('carries the label onto a thread it already sorted, without asking again', async () => {
    writeConfig()
    grantAt('none')
    let asks = 0
    const classifier = {
      ask: async () => { asks += 1; return { m1: { choice: 'receipt', confidence: 0.9 } } },
    } as unknown as Classifier
    gmail((url) => {
      if (url.includes('/messages?')) return json({ messages: [{ id: 'm1', threadId: 't1' }] })
      if (url.includes('/messages/m1')) return json({ id: 'm1', threadId: 't1', payload: { headers: [{ name: 'Subject', value: 'a nota' }] } })
      if (url.includes('/threads/t1')) {
        return json({ id: 't1', messages: [{ id: 'm1', threadId: 't1', payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'a nota' }], body: { data: Buffer.from('oi').toString('base64url') } } }] })
      }
      return json({})
    })
    const settings = new WebSettings(build({}, null, classifier), home)
    await settings.handle('email-inbox', { limit: 5 })
    await settings.handle('email-sort', { messages: [row] })

    const thread = (await settings.handle('email-thread', { threadId: 't1' })) as { messages: { labels: { id: string }[] }[] }
    expect(thread.messages[0]?.labels).toEqual([expect.objectContaining({ id: 'receipt' })])
    // The sort is the inbox's job; reading a thread only looks the labels up.
    expect(asks).toBe(1)
  })

  it('reads the inbox even when the classifier fails', async () => {
    writeConfig()
    grantAt('none')
    oneMessage()
    const broken = { ask: async () => { throw new Error('classifier review timed out') } } as unknown as Classifier
    const settings = new WebSettings(build({}, null, broken), home)
    const page = (await settings.handle('email-inbox', {})) as { messages: { labels: unknown[] }[]; labels: unknown[] }
    expect(page.messages).toHaveLength(1)
    expect(page.messages[0]?.labels).toEqual([])
  })

  /** A body of `size` characters, as Gmail hands it: base64url in a text/plain part. */
  const bodyOf = (size: number): Response =>
    json({
      id: 'm1',
      threadId: 't1',
      payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'a nota' }], body: { data: Buffer.from('x'.repeat(size)).toString('base64url') } },
    })

  it('reads a body past the thread cut, whole when it fits one chunk', async () => {
    writeConfig()
    grantAt('none')
    gmail(() => bodyOf(9_000))
    const settings = new WebSettings(build({}), home)

    const cut = (await settings.handle('email-message', { id: 'm1' })) as { truncated: boolean }
    expect(cut.truncated).toBe(true)

    const more = (await settings.handle('email-body', { id: 'm1' })) as { text: string; truncated: boolean; nextOffset?: number }
    expect(more.text).toHaveLength(9_000)
    expect(more.truncated).toBe(false)
    expect(more.nextOffset).toBeUndefined()
  })

  it('pages a text body longer than one chunk, and stops at the end', async () => {
    writeConfig()
    grantAt('none')
    gmail(() => bodyOf(25_000))
    const settings = new WebSettings(build({}), home)

    const first = (await settings.handle('email-body', { id: 'm1' })) as { text: string; truncated: boolean; nextOffset: number }
    expect(first.text).toHaveLength(20_000)
    expect(first.truncated).toBe(true)

    const rest = (await settings.handle('email-body', { id: 'm1', offset: first.nextOffset })) as { text: string; truncated: boolean; nextOffset?: number }
    expect(rest.text).toHaveLength(5_000)
    expect(rest.truncated).toBe(false)
    expect(rest.nextOffset).toBeUndefined()
  })

  it('fetches a page of mail in bounded batches, not all at once', async () => {
    writeConfig()
    grantAt('none')
    let inFlight = 0
    let peak = 0
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 })
      if (url.includes('/messages?')) return json({ messages: Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` })) })
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return json({ id: 'm', threadId: 't', payload: { headers: [] } })
    })

    const settings = new WebSettings(build({}), home)
    const page = (await settings.handle('email-inbox', { limit: 20 })) as { messages: unknown[] }
    expect(page.messages).toHaveLength(20)
    // The metadata requests over one page overlap inside a batch, never across the whole page.
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })

  it('adds and deletes a label from the screen, answering a bad colour with the valid ones', async () => {
    writeConfig()
    grantAt('none')
    const settings = new WebSettings(build({}), home)

    const made = (await settings.handle('email-label-create', { name: 'Invoices', color: 'teal' })) as { labels: { id: string; name: string }[] }
    const created = made.labels.find((label) => label.name === 'Invoices')
    expect(created).toBeTruthy()

    await expect(settings.handle('email-label-create', { name: 'Loud', color: 'chartreuse' })).rejects.toThrow(/terracotta/)

    const after = (await settings.handle('email-label-delete', { id: created!.id })) as { labels: { id: string }[] }
    expect(after.labels.some((label) => label.id === created!.id)).toBe(false)
  })

  it('says whether it can sort mail, from the classifier it was built with', async () => {
    writeConfig()
    grantAt('none')
    const without = new WebSettings(build({}), home)
    expect((await without.handle('email-status') as { sorting: boolean }).sorting).toBe(false)
    const withClassifier = new WebSettings(build({}, null, classifierOf({})), home)
    expect((await withClassifier.handle('email-status') as { sorting: boolean }).sorting).toBe(true)
  })

  it('puts a label on one message by hand, and takes it off', async () => {
    writeConfig()
    grantAt('none')
    oneMessage()
    const settings = new WebSettings(build({}, null, classifierOf({ m1: { choice: 'receipt', confidence: 0.9 } })), home)
    await settings.handle('email-inbox', { limit: 5 })
    await settings.handle('email-sort', { messages: [row] })
    const made = (await settings.handle('email-label-create', { name: 'Invoices', color: 'teal' })) as { labels: { id: string; name: string }[] }
    const id = made.labels.find((label) => label.name === 'Invoices')!.id

    expect(await settings.handle('email-label-assign', { id: 'm1', label: id, on: true })).toMatchObject({ on: true })
    const both = (await settings.handle('email-inbox', { limit: 5 })) as { messages: { labels: { id: string }[] }[] }
    expect(both.messages[0]?.labels.map((label) => label.id).sort()).toEqual([id, 'receipt'].sort())

    await settings.handle('email-label-assign', { id: 'm1', label: id, on: false })
    const after = (await settings.handle('email-inbox', { limit: 5 })) as { messages: { labels: { id: string }[] }[] }
    expect(after.messages[0]?.labels.map((label) => label.id)).toEqual(['receipt'])

    await expect(settings.handle('email-label-assign', { id: 'm1', label: 'nope', on: true })).rejects.toThrow(/No label/)
  })

  it('answers the badge with the unread newer than the last look', async () => {
    writeConfig()
    grantAt('modify')
    const asked: string[] = []
    gmail((url) => {
      asked.push(url)
      return json({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] })
    })
    const settings = new WebSettings(build({}), home)

    // Nothing has been looked at yet, so every unread in the inbox counts.
    expect(await settings.handle('email-unread')).toEqual({ count: 3, more: false })
    expect(new URL(asked[0]!).searchParams.get('q')).toBe('in:inbox is:unread')

    // Looking at the inbox moves the watermark, and the next count asks from there.
    await settings.handle('email-seen')
    expect(await settings.handle('email-unread')).toEqual({ count: 3, more: false })
    expect(new URL(asked[1]!).searchParams.get('q')).toMatch(/^in:inbox is:unread after:\d+$/)
  })

  it('has no badge without a grant, and reaches no Gmail for it', async () => {
    writeConfig()
    let called = 0
    vi.stubGlobal('fetch', async () => { called += 1; return json({}) })
    const settings = new WebSettings(build({}), home)

    expect(await settings.handle('email-unread')).toEqual({ count: 0, more: false })
    expect(called).toBe(0)
  })
})

describe('the Work screen’s projects', () => {
  const folder = (name: string): string => {
    const dir = path.join(home, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const addProject = async (settings: InstanceType<typeof WebSettings>, where: string, name: string): Promise<string> => {
    const added = (await settings.handle('project-action', { action: 'add', path: where, name })) as {
      projects: Array<{ id: string; name: string }>
    }
    return added.projects.find((project) => project.name === name)!.id
  }

  it('lists the projects, and says which folder is gone', async () => {
    const settings = new WebSettings(build(), home)
    const where = folder('milo')
    await addProject(settings, where, 'Milo')

    const listed = (await settings.handle('projects')) as Array<{ name: string; path: string }>
    expect(listed).toEqual([expect.objectContaining({ name: 'Milo', path: where })])

    rmSync(where, { recursive: true })
    const after = (await settings.handle('projects')) as Array<{ error?: string }>
    expect(after[0]?.error).toContain('is gone')
  })

  it('lists the folder a session moved in most recently first', async () => {
    const runtime = build()
    const settings = new WebSettings(runtime, home)
    const older = await addProject(settings, folder('older'), 'Older')
    const newer = await addProject(settings, folder('newer'), 'Newer')
    vi.spyOn(runtime, 'listSessions').mockResolvedValue([
      { id: 'calm-otter-1', label: 'New session', createdAt: 1, updatedAt: 10, messageCount: 1, preview: '', project: older },
      { id: 'calm-otter-2', label: 'New session', createdAt: 2, updatedAt: 20, messageCount: 1, preview: '', project: newer },
    ])

    const listed = (await settings.handle('projects')) as Array<{ id: string }>
    expect(listed.map((project) => project.id)).toEqual([newer, older])
  })

  it('adds, renames and drops one, and answers a refusal with the reason', async () => {
    const settings = new WebSettings(build(), home)
    const where = folder('milo')
    const id = await addProject(settings, where, 'Milo')

    const renamed = (await settings.handle('project-action', { action: 'update', id, name: 'Milo Work' })) as {
      result: string
      projects: Array<{ id: string; name: string }>
    }
    expect(renamed.result).toBe('Updated Milo Work.')
    expect(renamed.projects.find((project) => project.id === id)?.name).toBe('Milo Work')

    const missing = path.join(home, 'nowhere')
    await expect(settings.handle('project-action', { action: 'add', path: missing })).rejects.toThrow(
      `there is no folder at ${missing}`,
    )

    const removed = (await settings.handle('project-action', { action: 'remove', id })) as { result: string }
    expect(removed.result).toContain('Its sessions stay')
    expect(await settings.handle('projects')).toEqual([])
  })

  it('starts a work session in the project it was told to', async () => {
    const settings = new WebSettings(build(), home)
    const id = await addProject(settings, folder('milo'), 'Milo')

    const created = (await settings.handle('new-session', {
      chatId: CHAT,
      project: id,
    })) as { id: string }

    const sessions = (await settings.handle('sessions')) as Array<{ id: string; project?: string }>
    expect(sessions.find((session) => session.id === created.id)?.project).toBe(id)
  })

  it('answers an unknown project with the ones it knows', async () => {
    const settings = new WebSettings(build(), home)
    const id = await addProject(settings, folder('milo'), 'Milo')

    await expect(
      settings.handle('new-session', { chatId: CHAT, project: 'calm-otter-9' }),
    ).rejects.toThrow(`Known: ${id} — Milo`)
  })

  it('lists the folders of the machine the daemon runs on, and nothing that is a file', async () => {
    const settings = new WebSettings(build(), home)
    mkdirSync(path.join(home, 'code'))
    writeFileSync(path.join(home, 'notes.txt'), 'x')

    const listing = (await settings.handle('browse-folders', { path: home })) as {
      path: string
      folders: Array<{ name: string; path: string }>
    }
    expect(listing.path).toBe(home)
    expect(listing.folders.map((entry) => entry.name)).toContain('code')
    expect(listing.folders.map((entry) => entry.name)).not.toContain('notes.txt')

    const missing = path.join(home, 'nowhere')
    await expect(settings.handle('browse-folders', { path: missing })).rejects.toThrow(
      `could not read ${missing}`,
    )
  })

  it('refuses an action it does not know, naming the ones it does', async () => {
    const settings = new WebSettings(build(), home)
    await expect(settings.handle('project-action', { action: 'frobnicate', id: 'calm-otter-1' })).rejects.toThrow(
      'Use add, update or remove.',
    )
  })

  it('walks the project’s folder as a tree, and reads one file of it a page at a time', async () => {
    const settings = new WebSettings(build(), home)
    const where = folder('tree')
    mkdirSync(path.join(where, 'src'))
    writeFileSync(path.join(where, 'readme.md'), 'one\ntwo\n')
    writeFileSync(path.join(where, 'src', 'a.ts'), 'export const a = 1\n')
    const id = await addProject(settings, where, 'Tree')

    const tree = (await settings.handle('project-tree', { id })) as {
      nodes: Array<{ kind: string; rel: string }>
      files: number
      truncated: boolean
    }
    expect(tree.files).toBe(2)
    expect(tree.truncated).toBe(false)
    expect(tree.nodes.map((node) => `${node.kind}:${node.rel}`)).toEqual(['folder:src', 'file:readme.md'])

    const page = (await settings.handle('project-file', { id, path: 'readme.md' })) as { text: string; total: number; next?: number }
    expect(page.text).toBe('1\tone\n2\ttwo')
    expect(page.total).toBe(2)
    expect(page.next).toBeUndefined()
  })

  it('makes a folder in a project, and one while choosing where a project goes', async () => {
    const settings = new WebSettings(build(), home)
    const where = folder('makes-folders')
    const id = await addProject(settings, where, 'Folders')

    const tree = (await settings.handle('project-folder', { id, name: 'notes' })) as {
      nodes: Array<{ kind: string; rel: string }>
    }
    expect(tree.nodes.map((node) => `${node.kind}:${node.rel}`)).toEqual(['folder:notes'])

    const inside = (await settings.handle('project-folder', { id, parent: 'notes', name: 'inbox' })) as {
      nodes: Array<{ kind: string; rel: string; children?: Array<{ rel: string }> }>
    }
    expect(inside.nodes[0]?.children?.map((node) => node.rel)).toEqual(['notes/inbox'])

    const chosen = (await settings.handle('folder-create', { parent: home, name: 'chosen' })) as {
      path: string
      name: string
    }
    expect(chosen.path).toBe(path.join(home, 'chosen'))
    expect(chosen.name).toBe('chosen')

    await expect(settings.handle('project-folder', { id, name: '../escape' })).rejects.toThrow('is not a folder name.')
    await expect(settings.handle('folder-create', { name: '' })).rejects.toThrow('A folder is required.')
  })

  it('refuses a file outside the project, one it cannot read, and a tree of no project', async () => {
    const settings = new WebSettings(build(), home)
    const id = await addProject(settings, folder('tree-refusals'), 'Tree')

    await expect(settings.handle('project-file', { id, path: '../elsewhere.txt' })).rejects.toThrow(
      'is not inside Tree.',
    )
    await expect(settings.handle('project-file', { id, path: 'nope.txt' })).rejects.toThrow('could not read nope.txt')
    await expect(settings.handle('project-file', { id })).rejects.toThrow('A file is required.')
    await expect(settings.handle('project-tree', { id: 'calm-otter-9' })).rejects.toThrow('not in the list any more')
  })

  it('reads the changes from git, and says when the folder is not a repository', async () => {
    const settings = new WebSettings(build(), home)

    const plainId = await addProject(settings, folder('diff-plain'), 'Plain')
    expect(await settings.handle('project-diff', { id: plainId })).toEqual({
      ok: true,
      source: 'none',
      reason: 'Plain is not a git repository.',
    })

    const repo = folder('diff-repo')
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      })
    writeFileSync(path.join(repo, 'a.txt'), 'first\n')
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Milo Test')
    git('config', 'commit.gpgsign', 'false')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'first commit')
    writeFileSync(path.join(repo, 'a.txt'), 'second\n')
    const id = await addProject(settings, repo, 'Repo')

    const diff = (await settings.handle('project-diff', { id })) as {
      source: string
      files: Array<{ path: string; status: string; additions: number; hunks: unknown[] }>
    }
    expect(diff.source).toBe('git')
    expect(diff.files).toEqual([
      expect.objectContaining({ path: 'a.txt', status: 'modified', additions: 1 }),
    ])
    expect(diff.files[0]?.hunks).toHaveLength(1)
  })

  it('refuses a diff of a project that is not in the list', async () => {
    const settings = new WebSettings(build(), home)
    await expect(settings.handle('project-diff', { id: 'calm-otter-9' })).rejects.toThrow('not in the list any more')
  })

  it('starts a repository from the screen, and answers with the changes it made readable', async () => {
    const settings = new WebSettings(build(), home)
    const plain = folder('init-plain')
    writeFileSync(path.join(plain, 'a.txt'), 'hello\n')
    const id = await addProject(settings, plain, 'Plain')

    const tracked = (await settings.handle('project-track', { id })) as {
      source: string
      files: Array<{ path: string }>
      committed: boolean
    }
    // Everything in the folder is now the recorded state, so there is nothing to read yet
    // — which is what makes the section stop drawing the whole folder as one change.
    expect(tracked.source).toBe('git')
    expect(tracked.committed).toBe(true)
    expect(tracked.files).toEqual([])

    writeFileSync(path.join(plain, 'a.txt'), 'changed\n')
    const after = (await settings.handle('project-diff', { id })) as { files: Array<{ path: string; status: string }> }
    expect(after.files).toEqual([expect.objectContaining({ path: 'a.txt', status: 'modified' })])

    await expect(settings.handle('project-track', { id })).rejects.toThrow('already has its first state recorded')
  })

  it('says whether the folder carries rules, and hands over the words that write them', async () => {
    const settings = new WebSettings(build(), home)
    const where = folder('milo')
    const id = await addProject(settings, where, 'Milo')

    const none = (await settings.handle('project-rules', { id })) as { kind: string; prompt: string }
    expect(none.kind).toBe('absent')
    // One wording, served to every surface: the agent is told what to write in one place
    // rather than the phone and the browser each keeping a copy.
    expect(none.prompt).toContain('AGENTS.md')

    writeFileSync(path.join(where, 'AGENTS.md'), 'Run the suite before you call it done.\n')
    expect(((await settings.handle('project-rules', { id })) as { kind: string }).kind).toBe('present')

    writeFileSync(path.join(where, 'AGENTS.md'), 'x'.repeat(17 * 1024))
    const tooBig = (await settings.handle('project-rules', { id })) as { kind: string; error?: string }
    expect(tooBig.kind).toBe('unreadable')
    expect(tooBig.error).toContain('over the')
    // The file's own text never travels: a screen says the rules are there, it does not read them out.
    expect(tooBig).not.toHaveProperty('text')
  })

  it('refuses the rules of a project that is not in the list', async () => {
    const settings = new WebSettings(build(), home)
    await expect(settings.handle('project-rules', { id: 'calm-otter-9' })).rejects.toThrow(
      'No project with the id calm-otter-9.',
    )
  })
})
