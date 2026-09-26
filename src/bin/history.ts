import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { historyDir } from '../core/config/paths.js'
import { dayOf, historyDays, historyStatus, trimHistory } from '../core/history.js'
import { TurnIndex } from '../core/memory/turns.js'
import { errorMessage } from '../util/errors.js'
import { humanSize, shortenPath } from '../util/format.js'

export interface HistoryIo {
  out(line: string): void
  err(line: string): void
  confirm(question: string): Promise<boolean>
}

const USAGE = [
  'Usage:',
  '  milo history                              what the log holds',
  '  milo history trim --older-than <days>     delete day-files older than that',
  '  milo history trim --before <YYYY-MM-DD>   delete day-files from before that day',
  '',
  'Options:',
  '  --yes   skip the confirmation',
].join('\n')

/**
 * `milo history`. A terminal command, not a screen: it prints what the log costs
 * and, when asked, deletes the days it was told to. Nothing else in Milo trims
 * the log — a record is worth keeping — so this is the deliberate way to.
 */
export async function runHistory(argv: string[], io: Partial<HistoryIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  const confirm = io.confirm ?? askOnTty

  const args = argv[0] === 'history' ? argv.slice(1) : argv
  const [command, ...rest] = args

  try {
    switch (command ?? 'status') {
      case 'status':
      case 'list':
        return status(out)
      case 'trim':
        return await trim(rest, { out, err, confirm })
      case 'help':
        out(USAGE)
        return 0
      default:
        err(`Unknown: milo history ${command}`)
        err(USAGE)
        return 1
    }
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}

function status(out: HistoryIo['out']): number {
  const report = historyStatus()
  out(`${report.files} day-file(s), ${humanSize(report.bytes)}`)
  if (report.oldest && report.newest) out(`${report.oldest} → ${report.newest}`)
  out(shortenPath(report.dir, process.env.HOME ?? ''))
  if (report.files === 0) out('Nothing written yet.')
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

async function trim(argv: string[], context: Required<HistoryIo>): Promise<number> {
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

  const doomed = historyDays().filter((day) => day < before)
  if (doomed.length === 0) {
    context.out(`Nothing older than ${before}.`)
    return 0
  }

  const report = historyStatus()
  const kept = report.files - doomed.length
  if (!flags.yes && !(await context.confirm(`Delete ${doomed.length} day-file(s) from before ${before}? [y/N] `))) {
    context.out('Nothing deleted.')
    return 0
  }

  const removed = trimHistory(before)
  // The index is derived from the log, so the days that are gone are dropped from
  // it too — otherwise a turn from a deleted day would still answer a recall.
  const index = new TurnIndex({ dir: historyDir() })
  try {
    index.pruneBefore(new Date(`${before}T00:00:00`).toISOString())
  } finally {
    index.close()
  }

  context.out(`Deleted ${removed.length} day-file(s) — ${kept} kept.`)
  return 0
}

/**
 * Asks, unless there is nobody to ask. A piped `milo history trim` must not
 * delete by assuming the answer — a bare Enter is a no, and no terminal at all
 * is a no too.
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
