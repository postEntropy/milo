import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'
import { historyDir } from './config/paths.js'

/**
 * One line of the log. Everything a reader needs, so a search never has to join
 * two entries to answer a question.
 */
export interface HistoryEntry {
  /** ISO timestamp of the event itself, not of the turn it belongs to. */
  at: string
  /** The session's name (`calm-otter-7`), and the address it came from. */
  session: string
  scope: string
  kind: 'user' | 'assistant' | 'tool'
  text?: string
  reasoning?: string
  tool?: { name: string; args: unknown; result?: string; isError?: boolean }
}

export interface HistoryWriter {
  append(entries: HistoryEntry[]): void
}

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const FILE_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const DEFAULT_DAYS = 30
const DEFAULT_LIMIT = 20

/**
 * The long-term record: one JSONL file per day under `~/.milo/history`. Sessions
 * are the working state — they get cleared, compacted and deleted — and this is
 * what survives them, for a person reading back and for the model searching.
 */
export const fileHistory: HistoryWriter = {
  append(entries: HistoryEntry[]): void {
    if (entries.length === 0) return
    try {
      const dir = historyDir()
      mkdirSync(dir, { recursive: true, mode: DIR_MODE })
      const file = path.join(dir, `${dayOf(new Date())}.jsonl`)
      appendFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), {
        mode: FILE_MODE,
      })
    } catch (error) {
      // A log that cannot be written must never take a turn down with it.
      logWarn(`could not write the history: ${errorMessage(error)}`)
    }
  },
}

export interface HistorySearchOptions {
  /** How many of the most recent day-files to read. */
  days?: number
  /** Most entries to return. */
  limit?: number
  /** Only entries from this session (`calm-otter-7`). */
  session?: string
  /** Where the log lives; the app's data directory by default. */
  dir?: string
}

/** Entries mentioning every term, newest first. */
export function searchHistory(query: string, options: HistorySearchOptions = {}): HistoryEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const limit = options.limit ?? DEFAULT_LIMIT
  const hits: HistoryEntry[] = []

  for (const file of historyFiles(options.dir ?? historyDir(), options.days ?? DEFAULT_DAYS)) {
    for (const entry of readEntries(file)) {
      if (options.session && entry.session !== options.session) continue
      if (!matches(entry, terms)) continue
      hits.push(entry)
      if (hits.length >= limit) return hits
    }
  }

  return hits
}

/**
 * Every entry of one session, oldest first, across however many days it spans.
 *
 * All of them, not the last 30 days `searchHistory` reads: an export is about
 * the whole conversation, and a session picked up again after a month is still
 * one conversation. Nothing is sorted here — the log is appended in the order
 * things happened, and that order is the truthful one.
 */
export function readSession(id: string, options: { dir?: string } = {}): HistoryEntry[] {
  const dir = options.dir ?? historyDir()
  const files = historyFiles(dir, Number.POSITIVE_INFINITY).reverse()
  const entries: HistoryEntry[] = []
  for (const file of files) {
    for (const entry of readEntries(file).reverse()) {
      if (entry.session === id) entries.push(entry)
    }
  }
  return entries
}

/** Every day-file on disk, oldest first, as `YYYY-MM-DD`. Nothing when there is none. */
export function historyDays(dir: string = historyDir()): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => FILE_NAME.test(name))
      .sort()
      .map((name) => name.slice(0, 10))
  } catch {
    return []
  }
}

export interface HistoryStatus {
  /** Where the log lives. */
  dir: string
  /** Day-files on disk. */
  files: number
  /** What they cost together, the way `du` would read them. */
  bytes: number
  /** The oldest and newest day-files, when there are any. */
  oldest?: string
  newest?: string
}

/**
 * What the log costs. A readout, not a policy: Milo never trims the log on its
 * own — it is the record — so this is the number a person trims from, by hand.
 */
export function historyStatus(dir: string = historyDir()): HistoryStatus {
  const days = historyDays(dir)
  let bytes = 0
  for (const day of days) {
    try {
      bytes += statSync(path.join(dir, `${day}.jsonl`)).size
    } catch {
      // A file that vanished mid-count is simply not counted.
    }
  }
  return {
    dir,
    files: days.length,
    bytes,
    ...(days.length > 0 ? { oldest: days[0], newest: days[days.length - 1] } : {}),
  }
}

/**
 * Deletes every day-file from before `before` (`YYYY-MM-DD`) and returns the days
 * removed. The deliberate way to shrink the log: nothing calls it but
 * `milo history trim`, which asks first.
 */
export function trimHistory(before: string, dir: string = historyDir()): string[] {
  const removed: string[] = []
  for (const day of historyDays(dir)) {
    if (day >= before) continue
    try {
      rmSync(path.join(dir, `${day}.jsonl`), { force: true })
      removed.push(day)
    } catch {
      // Left in place and left out of the report: it is not gone.
    }
  }
  return removed
}

/** The day-files worth reading, newest first. A missing directory is no history. */
function historyFiles(dir: string, days: number): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => FILE_NAME.test(name))
      .sort()
      .reverse()
      .slice(0, days)
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

/** The entries of one file, newest first, skipping lines a crash left half-written. */
function readEntries(file: string): HistoryEntry[] {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const entries: HistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as HistoryEntry)
    } catch {
      // A torn last line — the process died mid-append — is not worth failing over.
    }
  }
  return entries.reverse()
}

function matches(entry: HistoryEntry, terms: string[]): boolean {
  const haystack = searchableText(entry)
  return terms.every((term) => haystack.includes(term))
}

/** Everything about an entry that is worth searching, as one lowercase string. */
function searchableText(entry: HistoryEntry): string {
  return [
    entry.text ?? '',
    entry.reasoning ?? '',
    entry.scope,
    entry.tool?.name ?? '',
    entry.tool ? safeJson(entry.tool.args) : '',
    entry.tool?.result ?? '',
  ]
    .join('\n')
    .toLowerCase()
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** The local day, so "today's file" is the day the person writing it is in. */
export function dayOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
