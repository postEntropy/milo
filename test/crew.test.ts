import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CrewStore } from '../src/core/crew.js'
import { extractToolBot } from '../src/core/crew-avatars.js'
import { crewTool } from '../src/core/tools/crew.js'

const dirs: string[] = []
function store(): { crew: CrewStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'milo-crew-'))
  dirs.push(dir)
  const file = join(dir, 'crew.json')
  return { crew: new CrewStore(file), file }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('Crew', () => {
  it('keeps a bot and its reports when it is renamed and reused', async () => {
    const { crew, file } = store()
    const first = await crew.start({ name: 'Scout', mission: 'Read the code', model: 'm1', sessionId: 's1' })
    await crew.finish(first.bot.id, first.assignment.id, 'completed', 'Found the entry point.')
    await crew.rename(first.bot.id, 'Sage')
    const second = await crew.start({ botId: first.bot.id, name: 'Sage', mission: 'Review it', model: 'm2', sessionId: 's2' })
    await crew.finish(second.bot.id, second.assignment.id, 'failed', 'The model failed.')
    expect(new CrewStore(file).list()).toMatchObject([{ name: 'Sage', assignments: [
      { mission: 'Read the code', state: 'completed', report: 'Found the entry point.', model: 'm1' },
      { mission: 'Review it', state: 'failed', report: 'The model failed.', model: 'm2' },
    ] }])
  })

  it('does not run the same bot twice at once', async () => {
    const { crew } = store()
    const first = await crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })
    await expect(crew.start({ botId: first.bot.id, name: 'Scout', mission: 'Review', model: 'm', sessionId: 's' })).rejects.toThrow('already working')
  })

  it('records a stop request and rejects stopping a finished bot', async () => {
    const { crew, file } = store()
    const first = await crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })
    await new CrewStore(file).stop(first.bot.id)
    expect(crew.list()[0]?.assignments[0]?.stopRequestedAt).toBeTypeOf('number')
    expect(await crew.finish(first.bot.id, first.assignment.id, 'completed', 'A partial report')).toBe('interrupted')
    await expect(crew.stop(first.bot.id)).rejects.toThrow('not working')
  })

  it('keeps guidance that the bot finished before taking up', async () => {
    const { crew } = store()
    const first = await crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })
    await crew.guide(first.bot.id, 'Look at tests too')
    await crew.finish(first.bot.id, first.assignment.id, 'completed', 'Done')
    expect(crew.list()[0]?.assignments[0]?.guidance).toEqual([{ id: expect.any(String), text: 'Look at tests too', at: expect.any(Number) }])
    await expect(crew.guide(first.bot.id, 'Too late')).rejects.toThrow('not accepting')
  })

  it('keeps concurrent changes made by separate store instances', async () => {
    const { crew, file } = store()
    const other = new CrewStore(file)
    await Promise.all([crew, other].map((instance, index) => instance.start({ name: `Bot ${index}`, mission: 'Read', model: 'm', sessionId: 's' })))
    expect(crew.list()).toHaveLength(2)
  })

  it('lists active bots before finished ones on every surface', async () => {
    const { crew } = store()
    const finished = await crew.start({ name: 'Sage', mission: 'Review', model: 'm', sessionId: 's' })
    await crew.finish(finished.bot.id, finished.assignment.id, 'completed', 'Done')
    await crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })
    expect(crew.list().map((bot) => bot.name)).toEqual(['Scout', 'Sage'])
  })

  it('reports a corrupt store without overwriting it', async () => {
    const { crew, file } = store()
    writeFileSync(file, '{bad')
    await expect(crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })).rejects.toThrow('Could not read crew')
    expect(readFileSync(file, 'utf8')).toBe('{bad')
  })

  it('marks an assignment interrupted when its process no longer exists', () => {
    const { crew, file } = store()
    writeFileSync(file, JSON.stringify([{ id: 'b', name: 'Scout', createdAt: 1, assignments: [{
      id: 'a', sessionId: 's', mission: 'Read', model: 'm', state: 'running', startedAt: 1, processId: 2147483647,
    }] }]))
    expect(crew.list()[0]?.assignments[0]).toMatchObject({ state: 'interrupted', report: expect.stringContaining('stopped') })
  })

  it('persists dead-process recovery on disk without creating an absent file', async () => {
    const { crew, file } = store()
    await crew.recover()
    expect(() => readFileSync(file, 'utf8')).toThrow()
    writeFileSync(file, JSON.stringify([{ id: 'b', name: 'Scout', createdAt: 1, assignments: [{
      id: 'a', sessionId: 's', mission: 'Read', model: 'm', state: 'running', startedAt: 1, processId: 2147483647,
    }] }]))
    await crew.recover()
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk[0]?.assignments[0]).toMatchObject({ state: 'interrupted', report: expect.stringContaining('stopped') })
  })

  it('assigns a deterministic avatar and allows shuffling or customizing traits', async () => {
    const { crew } = store()
    const first = await crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })
    expect(first.bot.avatar).toMatchObject({
      shape: expect.any(String),
      eyes: expect.any(String),
      accessory: expect.any(String),
      palette: expect.any(String),
    })
    const customized = await crew.updateAvatar(first.bot.id, { shape: 'dome', eyes: 'visor', accessory: 'antenna', palette: 'mint' })
    expect(customized.avatar).toEqual({ shape: 'dome', eyes: 'visor', accessory: 'antenna', palette: 'mint' })
    const shuffled = await crew.updateAvatar(first.bot.id, 'shuffle')
    expect(shuffled.avatar).not.toEqual(customized.avatar)
  })

  it('extracts a bot identity and avatar from a task tool call for inline display', () => {
    const running = extractToolBot({
      name: 'task',
      text: 'Task Scout · survey backend',
      input: 'name: Scout\ndescription: survey backend\nmodel: gpt-5.4\nprompt: Check SQL latency',
    })
    expect(running).toMatchObject({
      name: 'Scout',
      task: 'survey backend',
      model: 'gpt-5.4',
      mission: 'Check SQL latency',
    })
    const settled = extractToolBot({
      name: 'task',
      text: 'Task Scout · survey backend',
      result: 'Crew bot Scout (bot-123):\nAll queries under 12ms.',
    })
    expect(settled).toMatchObject({
      id: 'bot-123',
      name: 'Scout',
      report: 'All queries under 12ms.',
    })
  })

  it('parses stopped task output and bot names containing parentheses', () => {
    const stopped = extractToolBot({
      name: 'task',
      text: 'Task Scout (Lead) · survey',
      result: 'Crew bot Scout (Lead) (bot-99) was stopped. Partial report:\nPartial trace',
    })
    expect(stopped).toMatchObject({
      id: 'bot-99',
      name: 'Scout (Lead)',
      report: 'Partial trace',
    })
  })

  it('rejects explicit empty botId, trims newlines from names, caps assignments, and recovers dead PIDs', async () => {
    const { crew } = store()
    await expect(crew.start({ botId: '', name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })).rejects.toThrow('No bot has that id.')

    const { bot, assignment } = await crew.start({ name: 'Scout\nLead\n)', mission: 'First', model: 'm', sessionId: 's' })
    expect(bot.name).toBe('Scout Lead')
    await crew.finish(bot.id, assignment.id, 'completed', 'done')

    for (let index = 0; index < 55; index += 1) {
      const next = await crew.start({ botId: bot.id, name: bot.name, mission: `M${index}`, model: 'm', sessionId: 's' })
      await crew.finish(bot.id, next.assignment.id, 'completed', `R${index}`)
    }
    expect(crew.list()[0]?.assignments).toHaveLength(50)

    const { crew: pidCrew, file: pidFile } = store()
    await pidCrew.start({ name: 'Orphan', mission: 'Hang', model: 'm', sessionId: 's' })
    const raw = JSON.parse(readFileSync(pidFile, 'utf8')) as Array<{ assignments: Array<{ processId: number }> }>
    raw[0]!.assignments[0]!.processId = 999_999_999
    writeFileSync(pidFile, JSON.stringify(raw))
    await new CrewStore(pidFile).recover()
    expect(new CrewStore(pidFile).list()[0]?.assignments[0]?.state).toBe('interrupted')
  })

  it('exposes crewTool actions and rejects no-op avatar updates', async () => {
    const ctx = { cwd: tmpdir(), signal: new AbortController().signal }
    expect(await crewTool.execute({ action: 'list' }, ctx)).toEqual({
      content: 'Crew is not available in this session.',
      isError: true,
    })

    const { crew } = store()
    const { bot, assignment } = await crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })
    expect(JSON.parse((await crewTool.execute({ action: 'list' }, { ...ctx, crew })).content)).toHaveLength(1)
    expect(JSON.parse((await crewTool.execute({ action: 'show', id: bot.id }, { ...ctx, crew })).content).id).toBe(bot.id)
    expect((await crewTool.execute({ action: 'show', id: 'missing' }, { ...ctx, crew })).isError).toBe(true)

    expect(JSON.parse((await crewTool.execute({ action: 'rename', id: bot.id, name: 'Sage' }, { ...ctx, crew })).content).name).toBe('Sage')
    expect(await crewTool.execute({ action: 'avatar', id: bot.id }, { ...ctx, crew })).toEqual({
      content: 'Pass shuffle or at least one avatar trait (shape, eyes, accessory, palette).',
      isError: true,
    })
    expect(JSON.parse((await crewTool.execute({ action: 'avatar', id: bot.id, shape: 'orb' }, { ...ctx, crew })).content).avatar?.shape).toBe('orb')

    await crewTool.execute({ action: 'guide', id: bot.id, text: 'Focus on tests' }, { ...ctx, crew })
    await crewTool.execute({ action: 'stop', id: bot.id }, { ...ctx, crew })
    expect(crew.list()[0]?.assignments[0]).toMatchObject({
      id: assignment.id,
      stopRequestedAt: expect.any(Number),
      guidance: [{ text: 'Focus on tests' }],
    })

    expect((await crewTool.execute({ action: 'remove', id: bot.id }, { ...ctx, crew })).isError).toBe(true)
    await crew.finish(bot.id, assignment.id, 'interrupted', 'Stopped')
    expect(await crewTool.execute({ action: 'remove', id: bot.id }, { ...ctx, crew })).toEqual({
      content: `Removed bot Sage (${bot.id}).`,
    })
    expect(crew.list()).toEqual([])
    expect((await crewTool.execute({ action: 'remove', id: 'missing' }, { ...ctx, crew })).isError).toBe(true)
  })

  it('removes an idle or dead-PID bot and refuses removing a running or unknown bot', async () => {
    const { crew, file } = store()
    const running = await crew.start({ name: 'Scout', mission: 'Read', model: 'm', sessionId: 's' })
    await expect(crew.remove(running.bot.id)).rejects.toThrow('still working')
    await expect(crew.remove('missing')).rejects.toThrow('No bot has that id.')

    await crew.finish(running.bot.id, running.assignment.id, 'completed', 'Done')
    const removed = await crew.remove(running.bot.id)
    expect(removed.name).toBe('Scout')
    expect(crew.list()).toEqual([])
    expect(new CrewStore(file).list()).toEqual([])

    writeFileSync(file, JSON.stringify([{ id: 'orphan', name: 'Orphan', createdAt: 1, assignments: [{
      id: 'a', sessionId: 's', mission: 'Hang', model: 'm', state: 'running', startedAt: 1, processId: 999_999_999,
    }] }]))
    expect((await crew.remove('orphan')).id).toBe('orphan')
    expect(crew.list()).toEqual([])
  })

  it('creates bots with unique handles and instructions before any mission and preserves legacy bots', async () => {
    const { crew, file } = store()
    const legacy = [{
      id: 'legacy-1',
      name: 'Scout',
      createdAt: 100,
      avatar: { shape: 'gem', eyes: 'spark', accessory: 'crown', palette: 'ocean' },
      assignments: [{ id: 'a1', sessionId: 's1', mission: 'Old mission', model: 'm1', state: 'completed', startedAt: 101 }],
    }]
    writeFileSync(file, JSON.stringify(legacy))

    const existing = crew.get('legacy-1')
    expect(existing).toMatchObject({
      id: 'legacy-1',
      name: 'Scout',
      handle: 'scout',
      avatar: { shape: 'gem', eyes: 'spark', accessory: 'crown', palette: 'ocean' },
    })

    const comunista = await crew.create({
      name: 'Comunista',
      instructions: 'Analyze policies from a Marxist socialist perspective.',
    })
    const capitalista = await crew.create({
      name: 'Capitalista',
      handle: 'capitalista',
      instructions: 'Defend free markets and price signals.',
    })

    expect(comunista.handle).toBe('comunista')
    expect(comunista.assignments).toEqual([])
    expect(capitalista.handle).toBe('capitalista')

    // Renaming display name keeps the explicit/frozen mention handle intact and updates instructions.
    const renamed = await crew.updateProfile(comunista.id, {
      name: 'Comunista Ortodoxo',
      instructions: 'Stay concise and emphasize social planning.',
    })
    expect(renamed.name).toBe('Comunista Ortodoxo')
    expect(renamed.handle).toBe('comunista')
    expect(renamed.instructions).toBe('Stay concise and emphasize social planning.')

    // Duplicate handle on create or update is rejected cleanly.
    await expect(crew.create({ name: 'Outro', handle: 'comunista' })).rejects.toThrow('already used')
    await expect(crew.updateProfile(capitalista.id, { handle: 'comunista' })).rejects.toThrow('already used')

    // Auto-created bots without custom handles get distinct handles when display names collide.
    const secondScout = await crew.start({ name: 'Scout', mission: 'Second scout', model: 'm', sessionId: 's2' })
    expect(secondScout.bot.handle).toBe('scout-2')

    // crewTool supports creating and updating bots too.
    const ctx = { cwd: tmpdir(), signal: new AbortController().signal, crew }
    const createdViaTool = JSON.parse((await crewTool.execute({
      action: 'create',
      name: 'Auditor',
      handle: 'auditor',
      instructions: 'Check edge cases.',
    }, ctx)).content)
    expect(createdViaTool).toMatchObject({ name: 'Auditor', handle: 'auditor', instructions: 'Check edge cases.' })

    const updatedViaTool = JSON.parse((await crewTool.execute({
      action: 'update',
      id: createdViaTool.id,
      instructions: 'Updated instructions.',
    }, ctx)).content)
    expect(updatedViaTool.instructions).toBe('Updated instructions.')
  })
})
