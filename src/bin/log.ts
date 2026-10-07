import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { tracesFile } from '../core/config/paths.js'
import { dayOf } from '../core/history.js'
import { readTraces, traceStatus, trimTraces, type TraceEvent } from '../core/traces.js'
import { errorMessage } from '../util/errors.js'
import { humanSize, shortenPath } from '../util/format.js'

export interface LogIo {
  out(line: string): void
  err(line: string): void
  confirm(question: string): Promise<boolean>
}

const USAGE = [
  'Usage:',
  '  milo log                              what the execution log holds',
  '  milo log tail [n]                     the last n events (20 by default)',
  '  milo log trim --older-than <days>     drop events from before that',
  '  milo log trim --before <YYYY-MM-DD>   drop events from before that day',
  '',
  'Options:',
  '  --yes   skip the confirmation',
].join('\n')

/**
 * `milo log`. A terminal command, not a screen: it prints what the execution log
 * holds, shows the last few events, and — only when asked — drops the old ones.
 * Nothing else trims it, so this is the deliberate way to make it smaller.
 */
export async function runLog(argv: string[], io: Partial<LogIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  const confirm = io.confirm ?? askOnTty

  const args = argv[0] === 'log' ? argv.slice(1) : argv
  const [command, ...rest] = args

  try {
    switch (command ?? 'status') {
      case 'status':
      case 'list':
        return status(out)
      case 'tail':
        return tail(rest, out, err)
      case 'trim':
        return await trim(rest, { out, err, confirm })
      case 'help':
        out(USAGE)
        return 0
      default:
        err(`Unknown: milo log ${command}`)
        err(USAGE)
        return 1
    }
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}

function status(out: LogIo['out']): number {
  const report = traceStatus()
  out(`${report.events} event(s), ${humanSize(report.bytes)}`)
  if (report.oldest && report.newest) out(`${report.oldest} → ${report.newest}`)
  out(shortenPath(report.file, process.env.HOME ?? ''))
  if (report.events === 0) {
    out('Nothing written yet.')
    return 0
  }
  // A breakdown by what happened, which is the first thing worth knowing: how
  // much of the log is model calls, how much is tools, how much is the classifier.
  for (const [event, count] of tally(readTraces())) out(`${count} × ${event}`)
  return 0
}

/** How many events of each kind, in a fixed order so the report reads the same every time. */
function tally(events: TraceEvent[]): [string, number][] {
  const order = ['turn', 'model.request', 'tool.call', 'classifier.request']
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.event, (counts.get(event.event) ?? 0) + 1)
  return order
    .filter((event) => counts.has(event))
    .map((event) => [event, counts.get(event)!] as [string, number])
}

function tail(argv: string[], out: LogIo['out'], err: LogIo['err']): number {
  const count = argv[0] === undefined ? 20 : Number(argv[0])
  if (!Number.isInteger(count) || count < 0) {
    err('tail needs a non-negative number of events.')
    err(USAGE)
    return 1
  }
  const events = readTraces({ limit: count })
  if (events.length === 0) {
    out('Nothing written yet.')
    return 0
  }
  for (const event of events) out(JSON.stringify(event))
  return 0
}

interface TrimFlags {
  days?: number
  before?: string
  yes: boolean
}

function parseTrim(argv: string[]): TrimFlags {
  const flags: TrimFlags = { yes: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--yes' || token === '-y') flags.yes = true
    else if (token === '--older-than') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value < 0) throw new Error('--older-than needs a number of days.')
      flags.days = value
    } else if (token === '--before') {
      const value = argv[++i]
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--before needs a date like 2025-01-31.')
      flags.before = value
    } else if (token.startsWith('-')) throw new Error(`Unknown option ${token}.`)
  }
  return flags
}

async function trim(argv: string[], context: Required<LogIo>): Promise<number> {
  const flags = parseTrim(argv)
  const before =
    flags.before ??
    (flags.days !== undefined
      ? dayOf(new Date(Date.now() - flags.days * 24 * 60 * 60 * 1000))
      : undefined)

  if (!before) {
    context.err('trim needs --older-than <days> or --before <YYYY-MM-DD>')
    context.err(USAGE)
    return 1
  }

  const report = traceStatus()
  const doomed = readTraces().filter((event) => event.at.slice(0, 10) < before).length
  if (doomed === 0) {
    context.out(`Nothing older than ${before}.`)
    return 0
  }

  if (!flags.yes && !(await context.confirm(`Drop ${doomed} event(s) from before ${before}? [y/N] `))) {
    context.out('Nothing dropped.')
    return 0
  }

  const removed = trimTraces(before)
  context.out(`Dropped ${removed} event(s) — ${report.events - removed} kept.`)
  context.out(shortenPath(tracesFile(), process.env.HOME ?? ''))
  return 0
}

/**
 * Asks, unless there is nobody to ask. A piped `milo log trim` must not trim by
 * assuming the answer — a bare Enter is a no, and no terminal at all is a no too.
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
