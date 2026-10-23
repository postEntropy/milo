import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Point the install somewhere throwaway *before* the path module is loaded.
const home = mkdtempSync(path.join(tmpdir(), 'milo-routines-cli-'))
process.env.MILO_HOME = home

const { runRoutines } = await import('../src/bin/routines.js')
const { readRoutines } = await import('../src/core/routines.js')

interface Ran {
  lines: string[]
  errors: string[]
  code: number
}

async function run(...args: string[]): Promise<Ran> {
  const lines: string[] = []
  const errors: string[] = []
  const code = await runRoutines(['routines', ...args], {
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  })
  return { lines, errors, code }
}

/** The same, with the confirmation prompt under the test's control. */
async function runWith(
  confirm: (question: string) => Promise<boolean>,
  ...args: string[]
): Promise<Ran & { asked: string[] }> {
  const lines: string[] = []
  const errors: string[] = []
  const asked: string[] = []
  const code = await runRoutines(['routines', ...args], {
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    confirm: async (question) => {
      asked.push(question)
      return confirm(question)
    },
  })
  return { lines, errors, asked, code }
}

describe('milo routines', () => {
  beforeEach(() => {
    // Every test starts from an empty list; the file itself is the state.
    rmSync(path.join(home, 'routines.json'), { force: true })
  })

  afterEach(() => {
    rmSync(path.join(home, 'routines.json'), { force: true })
  })

  it('caps a routine at a number of runs, and says what the cap does', async () => {
    const { lines, code } = await run('add', 'ping', '--every', '1m', '--limit', '5', '--gateway', 'none')

    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('every 1m, 5 runs')
    expect(lines.join('\n')).toContain('stops itself after 5 runs')
    expect(readRoutines()[0]!.limit).toBe(5)
  })

  it('answers a ceiling that is not a count with the ones it takes', async () => {
    const { errors, code } = await run('add', 'ping', '--every', '1m', '--limit', 'five', '--gateway', 'none')

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('whole number of runs')
  })

  it('reads a routine whose ceiling ran out as finished', async () => {
    writeFileSync(
      path.join(home, 'routines.json'),
      JSON.stringify([
        {
          id: 'calm-otter-1',
          name: 'ping',
          prompt: 'ping',
          when: { kind: 'every', minutes: 1 },
          target: { gateway: 'none' },
          limit: 2,
          runs: 2,
          enabled: false,
          createdAt: 0,
        },
      ]),
    )

    const { lines } = await run('list')

    expect(lines.join('\n')).toContain('every 1m, 2 runs')
    expect(lines.join('\n')).toContain('finished')
  })

  it('says how many runs a routine switched on again has left', async () => {
    await run('add', 'ping', '--every', '1m', '--limit', '3', '--gateway', 'none')

    const { lines } = await run('enable', readRoutines()[0]!.id)

    expect(lines.join('\n')).toContain('Enabled ')
    expect(lines.join('\n')).toContain('3 runs left')
  })

  it('says there is nothing when there is nothing', async () => {
    const { lines, code } = await run('list')

    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('No routines.')
  })

  it('adds a routine from a clock time, and says when it next runs', async () => {
    const { lines, code } = await run(
      'add',
      'look at the repo',
      '--at',
      '08:00',
      // Days are read in either language, and written back in English.
      '--days',
      'seg-sex',
      '--gateway',
      'telegram',
      '--to',
      '123',
    )

    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('08:00, mon–fri')
    expect(lines.join('\n')).toContain('telegram:123')

    const [saved] = readRoutines()
    expect(saved).toMatchObject({
      prompt: 'look at the repo',
      when: { kind: 'at', time: '08:00', days: [1, 2, 3, 4, 5] },
      target: { gateway: 'telegram', chatId: '123' },
      enabled: true,
    })
  })

  it('adds a routine on a day of the month, and says it back', async () => {
    const { lines, code } = await run(
      'add',
      'resumo',
      '--at',
      '09:00',
      '--day-of-month',
      '25',
      '--month',
      'dec',
      '--gateway',
      'none',
    )

    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('09:00, day 25 of December')
    expect(readRoutines()[0]!.when).toEqual({ kind: 'at', time: '09:00', dayOfMonth: [25], month: [12] })
  })

  it('refuses a weekday and a day of the month together', async () => {
    const { code, errors } = await run(
      'add',
      'x',
      '--at',
      '09:00',
      '--days',
      'mon',
      '--day-of-month',
      '1',
      '--gateway',
      'none',
    )

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('--every 2h')
    expect(readRoutines()).toEqual([])
  })

  it('adds a routine from an interval', async () => {
    const { code } = await run('add', 'status', '--every', '2h', '--gateway', 'discord', '--to', '42')

    expect(code).toBe(0)
    expect(readRoutines()[0]!.when).toEqual({ kind: 'every', minutes: 120 })
  })

  it('names a routine from its prompt when it was not given one', async () => {
    const { lines } = await run(
      'add',
      'look at the repo and tell me what moved since yesterday',
      '--every',
      '1h',
      '--gateway',
      'telegram',
      '--to',
      '123',
    )

    expect(readRoutines()[0]!.name).toBe('Look at the repo and tell me what moved…')
    expect(lines.join('\n')).toContain('Look at the repo and tell me what moved…')
  })

  it('insists on a destination, because a timer has no chat of its own', async () => {
    const { code, errors } = await run('add', 'look at the repo', '--at', '08:00')

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('--to')
    expect(readRoutines()).toEqual([])
  })

  it('refuses a time it cannot read', async () => {
    const { code, errors } = await run(
      'add',
      'look at the repo',
      '--at',
      'midday',
      '--gateway',
      'telegram',
      '--to',
      '123',
    )

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('--every 2h')
    expect(readRoutines()).toEqual([])
  })

  it('lists what it has, enables, disables and removes by id', async () => {
    await run('add', 'briefing', '--name', 'daily briefing', '--at', '08:00', '--gateway', 'telegram', '--to', '123')
    const id = readRoutines()[0]!.id

    const listed = await run('list')
    expect(listed.lines.join('\n')).toContain(id)
    expect(listed.lines.join('\n')).toContain('daily briefing')

    expect((await run('disable', id)).code).toBe(0)
    expect(readRoutines()[0]!.enabled).toBe(false)
    expect((await run('list')).lines.join('\n')).toContain('off')

    expect((await run('enable', id)).code).toBe(0)
    expect(readRoutines()[0]!.enabled).toBe(true)

    expect((await run('remove', id)).code).toBe(0)
    expect(readRoutines()).toEqual([])
  })

  it('says when an id is unknown', async () => {
    expect((await run('remove', 'nobody-here-1')).code).toBe(1)
    expect((await run('enable', 'nobody-here-1')).code).toBe(1)
    expect((await run('run', 'nobody-here-1')).code).toBe(1)
  })

  it('needs a configuration to try a routine by hand', async () => {
    await run('add', 'briefing', '--at', '08:00', '--gateway', 'telegram', '--to', '123')
    const id = readRoutines()[0]!.id

    const { code, errors } = await run('run', id)

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('No configuration found')
  })

  it('prints usage, and refuses a subcommand it does not have', async () => {
    expect((await run('help')).lines.join('\n')).toContain('Usage:')

    const unknown = await run('frobnicate')
    expect(unknown.code).toBe(1)
    expect(unknown.errors.join('\n')).toContain('Unknown: milo routines frobnicate')
  })

  it('asks before taking a standing grant, and saves it when confirmed', async () => {
    const result = await runWith(
      async () => true,
      'add',
      'append tick',
      '--every',
      '1m',
      '--gateway',
      'telegram',
      '--to',
      '123',
      '--allow',
      'shell_command',
    )

    expect(result.code).toBe(0)
    expect(result.asked[0]).toContain('shell_command')
    expect(result.asked[0]).toContain('nobody there to confirm')
    expect(readRoutines()[0]!.allow).toEqual(['shell_command'])
    expect(result.lines.join('\n')).toContain('Granted: shell_command')
  })

  it('saves nothing when the grant is refused', async () => {
    const result = await runWith(
      async () => false,
      'add',
      'append tick',
      '--every',
      '1m',
      '--gateway',
      'telegram',
      '--to',
      '123',
      '--allow',
      'shell_command',
    )

    expect(result.code).toBe(0)
    expect(result.lines.join('\n')).toContain('Nothing saved.')
    expect(readRoutines()).toEqual([])
  })

  it('takes --yes as the answer, for a script', async () => {
    const result = await runWith(
      async () => {
        throw new Error('should not have asked')
      },
      'add',
      'append tick',
      '--every',
      '1m',
      '--gateway',
      'telegram',
      '--to',
      '123',
      '--allow',
      'write_file',
      '--yes',
    )

    expect(result.code).toBe(0)
    expect(readRoutines()[0]!.allow).toEqual(['write_file'])
  })

  it('rejects an unknown granted name and lists the valid tools', async () => {
    const result = await runWith(
      async () => true,
      'add',
      'x',
      '--every',
      '1m',
      '--gateway',
      'telegram',
      '--to',
      '123',
      '--allow',
      'teleport',
    )

    expect(result.code).toBe(1)
    expect(result.errors.join('\n')).toContain('Not a tool I know: teleport')
    expect(result.errors.join('\n')).toContain('gmail_modify')
    expect(readRoutines()).toEqual([])
  })

  it('accepts the mail tools that routines may be granted', async () => {
    const result = await runWith(
      async () => true,
      'add', 'sort newsletter', '--every', '1d', '--gateway', 'none',
      '--allow', 'gmail_modify,mail_labels',
    )

    expect(result.code).toBe(0)
    expect(readRoutines()[0]!.allow).toEqual(['gmail_modify', 'mail_labels'])
  })

  it('lists the grants a routine carries', async () => {
    await runWith(
      async () => true,
      'add',
      'x',
      '--every',
      '1m',
      '--gateway',
      'telegram',
      '--to',
      '123',
      '--allow',
      'shell_command',
    )

    expect((await run('list')).lines.join('\n')).toContain('may use shell_command with nobody there')
  })
})
