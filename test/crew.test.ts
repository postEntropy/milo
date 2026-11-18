import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CrewStore } from '../src/core/crew.js'
import { extractToolBot } from '../src/core/crew-avatars.js'

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
})
