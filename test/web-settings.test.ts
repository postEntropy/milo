import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServers } from '../src/core/mcp/servers.js'
import { stringify } from 'yaml'
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

const CONVERSATION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

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
      target: { gateway: 'web', conversationId: CONVERSATION },
    }) as { routine: { id: string; name: string } }
    expect(created.routine.name).toContain('look at the repo')

    type View = { id: string; whenLabel: string; targetLabel: string; enabled: boolean; nextRunAt: number | null }
    let listed = await settings.handle('routines') as View[]
    expect(listed).toHaveLength(1)
    expect(listed[0]!.whenLabel).toBe('every 2h')
    expect(listed[0]!.targetLabel).toBe(`web:${CONVERSATION}`)
    expect(listed[0]!.nextRunAt).toBeGreaterThan(Date.now())

    // It is the same file the timer reads, so `milo routines` sees it too.
    const onDisk = JSON.parse(readFileSync(path.join(home, 'routines.json'), 'utf8'))
    expect(onDisk[0].target).toEqual({ gateway: 'web', conversationId: CONVERSATION })

    await settings.handle('routine-enable', { id: created.routine.id, enabled: false })
    listed = await settings.handle('routines') as View[]
    expect(listed[0]!.enabled).toBe(false)
    expect(listed[0]!.nextRunAt).toBeNull()

    expect(await settings.handle('routine-remove', { id: created.routine.id })).toEqual({ removed: true })
    expect(await settings.handle('routines')).toEqual([])
  })

  it('refuses a destination that is not a surface', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    await expect(settings.handle('routine-add', {
      prompt: 'x',
      every: '2h',
      target: { gateway: 'carrier-pigeon', conversationId: '1' },
    })).rejects.toThrow('destination')
    await expect(settings.handle('routine-add', { prompt: 'x', every: '2h' })).rejects.toThrow('destination')
    await expect(settings.handle('routine-add', { prompt: 'x', target: { gateway: 'web', conversationId: '1' } }))
      .rejects.toThrow('Set a time')
  })

  it('runs one now and answers with what it said, and with the run it made', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    const created = await settings.handle('routine-add', {
      prompt: 'say nothing',
      every: '6h',
      target: { gateway: 'web', conversationId: CONVERSATION },
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
  it('deletes a saved session but refuses the one being looked at', async () => {
    writeConfig()
    const runtime = build({})
    const settings = new WebSettings(runtime, home)

    const session = await runtime.newSession({ gateway: 'web', conversationId: CONVERSATION })
    await expect(settings.handle('session-delete', { id: session.id, current: session.id }))
      .rejects.toThrow('conversation you are in')

    expect(await settings.handle('session-delete', { id: session.id, current: 'other-otter-1' }))
      .toEqual({ removed: true })
    expect((await settings.handle('sessions') as Array<{ id: string }>).some((item) => item.id === session.id)).toBe(false)
    await expect(settings.handle('session-delete', { id: session.id })).rejects.toThrow('not found')
  })

  it('renames a saved session', async () => {
    writeConfig()
    const runtime = build({})
    const settings = new WebSettings(runtime, home)

    const session = await runtime.newSession({ gateway: 'web', conversationId: CONVERSATION })
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

  it('moves the running model on a save', async () => {
    writeConfig()
    const runtime = build({})
    const settings = new WebSettings(runtime, home)
    const before = await settings.handle('overview') as { config: Record<string, unknown> }

    await settings.handle('save-config', { config: { ...before.config, model: 'another-model' } })

    expect(runtime.model).toBe('another-model')
    expect(readConfig()?.model).toBe('another-model')
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
    const status = (await settings.handle('email-status')) as { kind: string; access: string; tiers: { id: string }[] }
    expect(status.kind).toBe('connected')
    expect(status.access).toBe('modify')
    expect(status.tiers.map((tier) => tier.id)).toEqual(['none', 'modify', 'compose', 'send'])
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

  it('triages the unread mail', async () => {
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
    const result = (await settings.handle('email-assist', { mode: 'triage' })) as { text: string }
    expect(result.text).toBe('Answer Ana.')
  })

  it('answers an unknown assistance with the ones it knows', async () => {
    writeConfig()
    grantAt('none')
    const settings = new WebSettings(build({}), home)
    await expect(settings.handle('email-assist', { mode: 'translate' })).rejects.toThrow(/triage/)
  })
})
