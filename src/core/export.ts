import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportsDir } from './config/paths.js'
import { readSession, type HistoryEntry } from './history.js'
import { humanSize, plural } from '../util/format.js'
import { formatWhen } from './sessions/format.js'

/**
 * Taking a session out of Milo, as a file.
 *
 * The source is the history log and not the session's own transcript, and that
 * choice is the whole design: a transcript is compacted as it grows — the oldest
 * turns become a summary — and its old screenshots are dropped, so exporting it
 * would export what is left rather than what happened. The log has every message,
 * every tool call with its arguments and its **full** result, and the model's
 * reasoning, and it has it for as long as the log exists.
 *
 * Rendering lives here, apart from the command that triggers it, so the format
 * is testable without a session, a surface or a file.
 */

export type ExportFormat = 'md' | 'json'

export interface ExportMeta {
  id: string
  title?: string
  /** When this file was written, not when the conversation ran. */
  exportedAt: number
}

export interface ExportResult {
  path: string
  entries: number
  /** Messages: what the person said and what Milo answered. */
  messages: number
  toolCalls: number
  bytes: number
}

/** A fence long enough that backticks inside the text cannot end it early. */
function fence(text: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Arbitrary text — a tool result, a thought — as something Markdown will not mangle. */
function block(text: string): string {
  const body = text.replace(/\s+$/, '')
  const mark = fence(body)
  return `${mark}\n${body}\n${mark}`
}

function counts(entries: HistoryEntry[]): { messages: number; toolCalls: number } {
  let messages = 0
  let toolCalls = 0
  for (const entry of entries) {
    if (entry.kind === 'tool') toolCalls += 1
    else messages += 1
  }
  return { messages, toolCalls }
}

/**
 * When an event happened, on the reader's own clock.
 *
 * Local, like every other time in this file: the log keeps UTC, and an event
 * header cut out of the raw timestamp sat three hours away from the "first
 * event" line right above it. A document that disagrees with itself about the
 * time is worse than one that says nothing.
 */
function clock(at: string): string {
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return at
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
}

/**
 * One event, as a section: who, when, and then what it carried.
 *
 * Plain Markdown only — headings, bold, inline code and fenced blocks. No HTML,
 * because the file is read in a terminal as often as in an editor and the
 * terminal renders `<details>` as the word `<details>`.
 */
function event(entry: HistoryEntry): string {
  const when = clock(entry.at)
  const lines: string[] = []

  if (entry.kind === 'tool') {
    const tool = entry.tool
    lines.push(`## tool · ${tool?.name ?? 'unknown'} · ${when}${tool?.isError ? ' · failed' : ''}`)
    lines.push('', '**Arguments**', '', block(JSON.stringify(tool?.args ?? {}, null, 2)))
    if (typeof tool?.result === 'string' && tool.result.trim()) {
      lines.push('', `**Result**${tool.isError ? ' — it failed' : ''}`, '', block(tool.result))
    }
    return lines.join('\n')
  }

  lines.push(`## ${entry.kind === 'user' ? 'you' : 'milo'} · ${when}`)
  // The log carries the reasoning once per turn, on the answer it produced —
  // every step of it, in the order it arrived.
  if (entry.reasoning?.trim()) {
    lines.push('', '**Reasoning**', '', block(entry.reasoning))
  }
  if (entry.text?.trim()) lines.push('', entry.text.trim())
  return lines.join('\n')
}

export function renderExportMarkdown(meta: ExportMeta, entries: HistoryEntry[]): string {
  const { messages, toolCalls } = counts(entries)
  const scopes = [...new Set(entries.map((entry) => entry.scope).filter(Boolean))]

  const header = [
    `# ${meta.id}${meta.title ? ` — ${meta.title}` : ''}`,
    '',
    `- **Session** \`${meta.id}\``,
    ...(scopes.length > 0 ? [`- **Scope** ${scopes.map((scope) => `\`${scope}\``).join(', ')}`] : []),
    ...(entries.length > 0
      ? [`- **First event** ${formatWhen(Date.parse(entries[0]!.at))}`, `- **Last event** ${formatWhen(Date.parse(entries[entries.length - 1]!.at))}`]
      : []),
    `- **Held** ${plural(messages, 'message')} · ${plural(toolCalls, 'tool call')}`,
    `- **Exported** ${formatWhen(meta.exportedAt)}`,
    '',
    'This is the history log, which is the complete record: every message, every tool call with its',
    'arguments and its full result, and the reasoning. A session\'s own transcript is compacted as it',
    'grows and its old screenshots are dropped, so this is the file to read when the question is what',
    'actually happened.',
  ].join('\n')

  const body = entries.map(event).join('\n\n---\n\n')
  return entries.length > 0 ? `${header}\n\n---\n\n${body}\n` : `${header}\n`
}

export function renderExportJson(meta: ExportMeta, entries: HistoryEntry[]): string {
  const { messages, toolCalls } = counts(entries)
  return `${JSON.stringify(
    {
      session: meta.id,
      title: meta.title ?? null,
      exportedAt: new Date(meta.exportedAt).toISOString(),
      counts: { entries: entries.length, messages, toolCalls },
      entries,
    },
    null,
    2,
  )}\n`
}

/** The name an export is written under: the session, and the moment it was taken. */
export function exportFileName(id: string, format: ExportFormat, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${id}-${stamp}.${format === 'json' ? 'json' : 'md'}`
}

export interface WriteExportOptions {
  id: string
  title?: string
  format?: ExportFormat
  /** Where the log is read from, and where the file goes. For tests. */
  historyDir?: string
  outDir?: string
  now?: Date
}

/**
 * Writes a session out. Returns null when there is nothing to write — a session
 * with no log lines is not an empty file, it is an answer.
 */
export async function writeSessionExport(options: WriteExportOptions): Promise<ExportResult | null> {
  const entries = readSession(options.id, { dir: options.historyDir })
  if (entries.length === 0) return null

  const format = options.format ?? 'md'
  const now = options.now ?? new Date()
  const meta: ExportMeta = { id: options.id, title: options.title, exportedAt: now.getTime() }
  const body = format === 'json' ? renderExportJson(meta, entries) : renderExportMarkdown(meta, entries)

  const dir = options.outDir ?? exportsDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, exportFileName(options.id, format, now))
  // Private: a transcript is what the person said.
  await writeFile(file, body, { mode: 0o600 })

  const { messages, toolCalls } = counts(entries)
  return { path: file, entries: entries.length, messages, toolCalls, bytes: Buffer.byteLength(body) }
}

/** The one line a surface replies with. */
export function describeExport(result: ExportResult): string {
  return (
    `📄 Exported to ${result.path}\n` +
    `${plural(result.messages, 'message')} · ${plural(result.toolCalls, 'tool call')} · ${humanSize(result.bytes)}`
  )
}
