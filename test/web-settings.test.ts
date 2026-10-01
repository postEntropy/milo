import { afterEach, describe, expect, it, vi } from 'vitest'
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

function build(memory: Record<string, unknown> = {}): InstanceType<typeof AgentRuntime> {
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
  })
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
    expect(overview).toContain('••••••••')
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

  it('runs one now and answers with what it said', async () => {
    writeConfig()
    const settings = new WebSettings(build({}), home)
    const created = await settings.handle('routine-add', {
      prompt: 'say nothing',
      every: '6h',
      target: { gateway: 'web', conversationId: CONVERSATION },
    }) as { routine: { id: string } }

    // The fake provider streams nothing, so the run succeeds with an empty answer.
    expect(await settings.handle('routine-run', { id: created.routine.id })).toEqual({ answer: '', failure: null })
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

    expect(await settings.handle('install-skill', { source: 'local/skill', scope: 'global' }))
      .toMatchObject({ installed: 'solo', scope: 'global' })
    expect(readFileSync(path.join(home, 'skills', 'solo', 'SKILL.md'), 'utf8')).toContain('one skill')

    // Several skills are not guessed at: the names come back for the person to pick.
    expect(await settings.handle('install-skill', { source: 'multi/repo' })).toEqual({ needChoice: ['one', 'two'] })
    expect(await settings.handle('install-skill', { source: 'multi/repo', skill: 'two', scope: 'project' }))
      .toMatchObject({ installed: 'two', scope: 'project' })
    expect(readFileSync(path.join(home, '.milo', 'skills', 'two', 'SKILL.md'), 'utf8')).toContain('second')
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
