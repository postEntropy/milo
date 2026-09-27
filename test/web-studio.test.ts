import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-web-studio-'))
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

const { WebStudio } = await import('../src/gateways/web/studio.js')
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

describe('web Studio secret handling', () => {
  it('never returns API keys or custom headers in overview', async () => {
    writeFileSync(path.join(home, 'config.yml'), stringify({
      provider: 'test',
      model: 'test-model',
      providers: { test: { baseURL: 'https://provider.example/v1', headers: { authorization: 'Bearer header-secret' } } },
    }))
    saveAuth({ providers: { test: 'provider-secret' }, gateways: {}, search: {} })
    const studio = new WebStudio(build({}), home)
    const overview = JSON.stringify(await studio.handle('overview'))
    expect(overview).not.toContain('provider-secret')
    expect(overview).not.toContain('header-secret')
    expect(overview).toContain('••••••••')
  })

  it('reports the live model and effort, not the effort twice', async () => {
    writeConfig()
    const studio = new WebStudio(build({}), home)
    const overview = await studio.handle('overview') as { live: { model: string; effort: string } }
    expect(overview.live.model).toBe('test-model')
    expect(overview.live.effort).toBe('medium')
  })
})

describe('web Studio memory notes', () => {
  it('lists the notes and forgets one', async () => {
    writeConfig()
    const forgotten: string[] = []
    const studio = new WebStudio(build({
      list: async () => [NOTE],
      forget: async (_scope: unknown, id: string) => { forgotten.push(id); return true },
    }), home)

    const listed = await studio.handle('memory-notes') as { notes: typeof NOTE[] }
    expect(listed.notes.map((note) => note.text)).toEqual(['prefers tabs'])

    const result = await studio.handle('forget-note', { id: NOTE.id })
    expect(result).toEqual({ removed: true })
    expect(forgotten).toEqual([NOTE.id])
    await expect(studio.handle('forget-note', {})).rejects.toThrow('note id')
  })
})

describe('web Studio routines', () => {
  it('creates, lists, pauses and removes one, targeting the web chat', async () => {
    writeConfig()
    const studio = new WebStudio(build({}), home)

    const created = await studio.handle('routine-add', {
      prompt: 'look at the repo and tell me what moved',
      every: '2h',
      target: { gateway: 'web', conversationId: CONVERSATION },
    }) as { routine: { id: string; name: string } }
    expect(created.routine.name).toContain('look at the repo')

    type View = { id: string; whenLabel: string; targetLabel: string; enabled: boolean; nextRunAt: number | null }
    let listed = await studio.handle('routines') as View[]
    expect(listed).toHaveLength(1)
    expect(listed[0]!.whenLabel).toBe('every 2h')
    expect(listed[0]!.targetLabel).toBe(`web:${CONVERSATION}`)
    expect(listed[0]!.nextRunAt).toBeGreaterThan(Date.now())

    // It is the same file the timer reads, so `milo routines` sees it too.
    const onDisk = JSON.parse(readFileSync(path.join(home, 'routines.json'), 'utf8'))
    expect(onDisk[0].target).toEqual({ gateway: 'web', conversationId: CONVERSATION })

    await studio.handle('routine-enable', { id: created.routine.id, enabled: false })
    listed = await studio.handle('routines') as View[]
    expect(listed[0]!.enabled).toBe(false)
    expect(listed[0]!.nextRunAt).toBeNull()

    expect(await studio.handle('routine-remove', { id: created.routine.id })).toEqual({ removed: true })
    expect(await studio.handle('routines')).toEqual([])
  })

  it('refuses a destination that is not a surface', async () => {
    writeConfig()
    const studio = new WebStudio(build({}), home)
    await expect(studio.handle('routine-add', {
      prompt: 'x',
      every: '2h',
      target: { gateway: 'carrier-pigeon', conversationId: '1' },
    })).rejects.toThrow('destination')
    await expect(studio.handle('routine-add', { prompt: 'x', every: '2h' })).rejects.toThrow('destination')
    await expect(studio.handle('routine-add', { prompt: 'x', target: { gateway: 'web', conversationId: '1' } }))
      .rejects.toThrow('Set a time')
  })

  it('runs one now and answers with what it said', async () => {
    writeConfig()
    const studio = new WebStudio(build({}), home)
    const created = await studio.handle('routine-add', {
      prompt: 'say nothing',
      every: '6h',
      target: { gateway: 'web', conversationId: CONVERSATION },
    }) as { routine: { id: string } }

    // The fake provider streams nothing, so the run succeeds with an empty answer.
    expect(await studio.handle('routine-run', { id: created.routine.id })).toEqual({ answer: '', failure: null })
    await expect(studio.handle('routine-run', { id: 'no-such-routine' })).rejects.toThrow('No routine')
  })
})

describe('web Studio sessions', () => {
  it('deletes a saved session but refuses the one being looked at', async () => {
    writeConfig()
    const runtime = build({})
    const studio = new WebStudio(runtime, home)

    const session = await runtime.newSession({ gateway: 'web', conversationId: CONVERSATION })
    await expect(studio.handle('session-delete', { id: session.id, current: session.id }))
      .rejects.toThrow('conversation you are in')

    expect(await studio.handle('session-delete', { id: session.id, current: 'other-otter-1' }))
      .toEqual({ removed: true })
    expect((await studio.handle('sessions') as Array<{ id: string }>).some((item) => item.id === session.id)).toBe(false)
    await expect(studio.handle('session-delete', { id: session.id })).rejects.toThrow('not found')
  })
})

describe('web Studio skills', () => {
  it('installs one skill, and asks which one when the source holds several', async () => {
    writeConfig()
    const studio = new WebStudio(build({}), home)

    expect(await studio.handle('install-skill', { source: 'local/skill', scope: 'global' }))
      .toMatchObject({ installed: 'solo', scope: 'global' })
    expect(readFileSync(path.join(home, 'skills', 'solo', 'SKILL.md'), 'utf8')).toContain('one skill')

    // Several skills are not guessed at: the names come back for the person to pick.
    expect(await studio.handle('install-skill', { source: 'multi/repo' })).toEqual({ needChoice: ['one', 'two'] })
    expect(await studio.handle('install-skill', { source: 'multi/repo', skill: 'two', scope: 'project' }))
      .toMatchObject({ installed: 'two', scope: 'project' })
    expect(readFileSync(path.join(home, '.milo', 'skills', 'two', 'SKILL.md'), 'utf8')).toContain('second')
  })
})

describe('web Studio jobs', () => {
  it('reports progress through the registry and refuses what it cannot run', async () => {
    writeConfig()
    const studio = new WebStudio(build({}), home)

    await expect(studio.handle('job-start', { kind: 'make-coffee' })).rejects.toThrow('Unknown job kind')
    await expect(studio.handle('job-start', { kind: 'profile-copy', id: '../escape', dir: '/tmp' }))
      .rejects.toThrow('Invalid browser id')
    await expect(studio.handle('job-start', { kind: 'profile-copy', id: 'chromium' })).rejects.toThrow('profile directory')
    await expect(studio.handle('job-status', { id: 'nope' })).rejects.toThrow('No such job')
  })
})

describe('web Studio config', () => {
  it('keeps the web section and its own address through a save', async () => {
    writeConfig()
    const studio = new WebStudio(build({}), home)
    const before = await studio.handle('overview') as { config: Record<string, unknown> }
    // The defaults are there even though the file never mentioned them.
    expect(before.config.web).toEqual({ enabled: true, host: '127.0.0.1', port: 7717 })

    const next = { ...before.config, web: { enabled: true, host: '0.0.0.0', port: 8123 } }
    await studio.handle('save-config', { config: next })
    expect(readConfig()?.web).toEqual({ enabled: true, host: '0.0.0.0', port: 8123 })
  })
})
