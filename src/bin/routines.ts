import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { createRuntime } from '../core/bootstrap.js'
import { loadConfig } from '../core/config/load.js'
import {
  addRoutine,
  describeTarget,
  describeWhen,
  findRoutine,
  formatLocal,
  nextRunAt,
  parseWhen,
  readRoutines,
  removeRoutine,
  ROUTINE_GATEWAYS,
  runRoutineOnce,
  setEnabled,
  type RoutineGateway,
} from '../core/routines.js'
import { builtinTools } from '../core/tools/index.js'
import { errorMessage } from '../util/errors.js'

export interface RoutineIo {
  out(line: string): void
  err(line: string): void
  confirm(question: string): Promise<boolean>
}

/**
 * Every tool a routine could be granted. The conditional ones (`web_search`, the
 * browser, `read_skill`) are named here because they only reach the registry when
 * the install is configured for them, and a grant for one should not be a typo
 * that quietly does nothing.
 */
const GRANTABLE = new Set([
  ...builtinTools.map((tool) => tool.name),
  'web_search',
  'read_skill',
  'browser_open',
  'browser_snapshot',
  'browser_screenshot',
  'browser_act',
])

const USAGE = [
  'Usage:',
  '  milo routines                              list the routines',
  '  milo routines add "<prompt>" --at 08:00 [--days mon-fri] --gateway telegram --to <chat id>',
  '  milo routines add "<prompt>" --every 2h --gateway discord --to <channel id>',
  '  milo routines add "<prompt>" --every 6h --gateway web --to <conversation id>',
  '  milo routines remove <id>                  delete a routine',
  '  milo routines enable|disable <id>          turn a routine on or off',
  '  milo routines run <id>                     fire it now, printing the answer (no delivery)',
  '',
  'A routine fires only while `milo serve` is running, and delivers its answer to',
  'the chat named by --gateway/--to (telegram, discord or web — a web conversation',
  'is the id in the browser\'s address). Times are local; `--days` takes mon,wed or',
  'a range like mon-fri.',
  '',
  'Reading needs no permission. A routine that writes or runs something needs the',
  'tool named in --allow shell_command,write_file — there is nobody at the other end',
  'to confirm, so what is not granted is refused. In `yolo` mode nothing is asked.',
].join('\n')

/**
 * `milo routines` — the terminal way to see and edit the prompts Milo runs on a
 * timer. In chat the assistant makes them from what you say; this is the same
 * list, by hand, and the only place a routine can be pointed at a chat the CLI is
 * not talking to.
 */
export async function runRoutines(argv: string[], io: Partial<RoutineIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  const confirm = io.confirm ?? askOnTty

  const args = argv[0] === 'routines' ? argv.slice(1) : argv
  const [command, ...rest] = args

  try {
    switch (command ?? 'list') {
      case 'list':
        return list(out)
      case 'add':
        return await add(rest, { out, err, confirm })
      case 'remove':
      case 'rm':
        return remove(rest, out, err)
      case 'enable':
        return toggle(rest, true, out, err)
      case 'disable':
        return toggle(rest, false, out, err)
      case 'run':
        return await run(rest, out, err)
      case 'help':
        out(USAGE)
        return 0
      default:
        err(`Unknown: milo routines ${command}`)
        err(USAGE)
        return 1
    }
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}

function list(out: RoutineIo['out']): number {
  const routines = readRoutines()
  if (routines.length === 0) {
    out('No routines.')
    out('Add one: milo routines add "look at the repo" --at 08:00 --gateway telegram --to <chat id>')
    return 0
  }

  const now = new Date()
  for (const routine of routines) {
    const name = routine.name ?? routine.prompt
    out(`${routine.enabled ? 'on  ' : 'off '} ${name}  (${routine.id})`)
    const timing = routine.enabled ? `next ${formatLocal(nextRunAt(routine.when, now))}` : 'paused'
    const last = routine.lastRunAt
      ? `last ${routine.lastResult ?? 'ok'} at ${formatLocal(new Date(routine.lastRunAt))}`
      : 'never run'
    out(`     ${describeWhen(routine.when)} → ${describeTarget(routine.target)} — ${timing}, ${last}`)
    if (routine.allow?.length) out(`     may use ${routine.allow.join(', ')} with nobody there`)
  }
  return 0
}

interface AddFlags {
  prompt: string
  name?: string
  every?: string
  at?: string
  days?: string[]
  gateway?: RoutineGateway
  conversationId?: string
  allow?: string[]
  yes: boolean
}

function parseAdd(argv: string[]): AddFlags {
  const positionals: string[] = []
  const flags: Omit<AddFlags, 'prompt' | 'yes'> & { yes?: boolean } = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    const value = (): string => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${token} needs a value.`)
      return next
    }
    if (token === '--name') flags.name = value()
    else if (token === '--every') flags.every = value()
    else if (token === '--at') flags.at = value()
    else if (token === '--days') flags.days = value().split(',').map((day) => day.trim()).filter(Boolean)
    else if (token === '--allow') {
      flags.allow = value().split(',').map((name) => name.trim()).filter(Boolean)
    } else if (token === '--yes' || token === '-y') flags.yes = true
    else if (token === '--gateway') {
      const gateway = value()
      if (!(ROUTINE_GATEWAYS as readonly string[]).includes(gateway)) {
        throw new Error(`--gateway must be one of ${ROUTINE_GATEWAYS.join(', ')}.`)
      }
      flags.gateway = gateway as RoutineGateway
    } else if (token === '--to' || token === '--conversation') flags.conversationId = value()
    else if (token.startsWith('-')) throw new Error(`Unknown option ${token}.`)
    else positionals.push(token)
  }

  return { ...flags, yes: flags.yes ?? false, prompt: positionals.join(' ').trim() }
}

async function add(argv: string[], context: Required<RoutineIo>): Promise<number> {
  const flags = parseAdd(argv)
  if (!flags.prompt) {
    context.err('add needs a prompt: milo routines add "look at the repo" --at 08:00 --gateway telegram --to <id>')
    context.err(USAGE)
    return 1
  }

  const when = parseWhen({ every: flags.every, at: flags.at, days: flags.days })
  if (!when) {
    context.err('add needs --every 2h, or --at 08:00 (with optional --days mon-fri).')
    context.err(USAGE)
    return 1
  }

  if (!flags.gateway || !flags.conversationId) {
    context.err('add needs --gateway telegram|discord|web and --to <chat id> — a timer has no chat of its own.')
    context.err(USAGE)
    return 1
  }

  if (flags.allow?.length) {
    const unknown = flags.allow.filter((name) => !GRANTABLE.has(name))
    if (unknown.length > 0) {
      context.err(`Not a tool I know: ${unknown.join(', ')} — the grant will do nothing.`)
    }
    // A standing grant is the whole reason this command can be dangerous: said
    // out loud, and confirmed, because nobody will be there when it runs.
    if (!flags.yes) {
      const question = `This routine may use ${flags.allow.join(', ')} with nobody there to confirm. Save it? [y/N] `
      if (!(await context.confirm(question))) {
        context.out('Nothing saved.')
        return 0
      }
    }
  }

  const routine = addRoutine({
    prompt: flags.prompt,
    name: flags.name,
    when,
    target: { gateway: flags.gateway, conversationId: flags.conversationId },
    allow: flags.allow?.length ? flags.allow : undefined,
    enabled: true,
  })
  context.out(
    `Created routine "${routine.name ?? routine.prompt}" (${routine.id}): ${describeWhen(routine.when)} → ${describeTarget(routine.target)}`,
  )
  if (routine.allow?.length) context.out(`Granted: ${routine.allow.join(', ')} (unattended)`)
  context.out(
    `Next ${formatLocal(nextRunAt(routine.when, new Date()))}. Remove with: milo routines remove ${routine.id}`,
  )
  return 0
}

function remove(argv: string[], out: RoutineIo['out'], err: RoutineIo['err']): number {
  const id = argv.find((token) => !token.startsWith('-'))
  if (!id) {
    err('remove needs a routine id (see milo routines list).')
    return 1
  }
  if (!removeRoutine(id)) {
    err(`No routine ${id}.`)
    return 1
  }
  out(`Removed ${id}.`)
  return 0
}

function toggle(
  argv: string[],
  enabled: boolean,
  out: RoutineIo['out'],
  err: RoutineIo['err'],
): number {
  const id = argv.find((token) => !token.startsWith('-'))
  if (!id) {
    err(`${enabled ? 'enable' : 'disable'} needs a routine id (see milo routines list).`)
    return 1
  }
  if (!setEnabled(id, enabled)) {
    err(`No routine ${id}.`)
    return 1
  }
  out(`${enabled ? 'Enabled' : 'Disabled'} ${id}.`)
  return 0
}

/**
 * Runs one routine now, printing what it answers. It does not deliver: a daemon
 * may be running, and two copies of the same report in the chat would be one too
 * many. This is how a prompt is tried without waiting for the clock.
 */
async function run(argv: string[], out: RoutineIo['out'], err: RoutineIo['err']): Promise<number> {
  const id = argv.find((token) => !token.startsWith('-'))
  if (!id) {
    err('run needs a routine id (see milo routines list).')
    return 1
  }
  const routine = findRoutine(id)
  if (!routine) {
    err(`No routine ${id}.`)
    return 1
  }
  const loaded = loadConfig()
  if (!loaded) {
    err('No configuration found. Run `milo` first to set things up.')
    return 1
  }

  const runtime = createRuntime(loaded, process.cwd())
  try {
    const { answer, failure } = await runRoutineOnce(runtime, routine)
    if (failure) err(`⚠ ${failure}`)
    out(answer || '(no answer)')
    out('(printed only — `run` does not deliver)')
    return failure ? 1 : 0
  } finally {
    await runtime.close().catch(() => undefined)
  }
}

/**
 * Asks, unless there is nobody to ask. A piped `milo routines add --allow …` must
 * not take a standing grant on the strength of a bare Enter — no terminal at all
 * is a no too, and `--yes` is how a script says it meant it.
 */
async function askOnTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await readline.question(question)).trim())
  } finally {
    readline.close()
  }
}
