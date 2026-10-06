import type { SessionStats, SessionSummary } from './types.js'

export const DEFAULT_PAGE_SIZE = 5

/**
 * What another holder of this session left in it, as one clause every surface
 * draws: turns that arrived, turns that are gone, and whether the older ones were
 * summarized. The one that is gone is said as plainly as the one that arrived —
 * a transcript that shrank in silence is a person reading a conversation the
 * model can no longer see.
 */
export function describeRebase(event: {
  added: number
  removed: number
  compacted: boolean
}): string {
  const says: string[] = []
  if (event.added > 0) says.push(`${event.added} new message${event.added === 1 ? '' : 's'}`)
  if (event.removed > 0) {
    says.push(`${event.removed} message${event.removed === 1 ? '' : 's'} dropped elsewhere`)
  }
  if (event.compacted) says.push('the earlier turns are summarized')
  return says.join(' and ')
}

export interface SessionListStyle {
  /** Render for a surface that understands Markdown (Telegram, Discord). */
  markdown?: boolean
  /** 1-based page number. Defaults to 1. */
  page?: number
  /** Number of sessions per page. Defaults to 5. */
  pageSize?: number
}

export function formatWhen(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

export function formatSessionList(
  sessions: SessionSummary[],
  style: SessionListStyle = {},
): string {
  const markdown = style.markdown ?? false
  const pageSize = style.pageSize ?? DEFAULT_PAGE_SIZE
  const totalPages = Math.max(1, Math.ceil(sessions.length / pageSize))
  const page = Math.min(Math.max(1, style.page ?? 1), totalPages)

  if (sessions.length === 0) {
    return markdown
      ? '🗂 **Sessions**\n\nNothing saved yet. `/new` starts one.'
      : 'Sessions\n\nNothing saved yet. /new starts one.'
  }

  const offset = (page - 1) * pageSize
  const pageSessions = sessions.slice(offset, offset + pageSize)

  const entries = pageSessions.map((session) => {
    const label = session.title ? `${session.id} — ${session.title}` : session.id
    const name = markdown ? `**${label}**` : label
    const meta = `${session.messageCount} msgs · ${formatWhen(session.updatedAt)}`
    const detail = markdown ? meta : `  ${meta}`
    // The recap says what the session was about; the preview is the fallback for
    // one that was never switched away from, so it never got one. In a listing of
    // sessions, only the first bullet of the recap is shown so replies do not
    // outgrow the chat.
    const summary = summarizeRecap(session.recap, session.preview)
    const body = quote(summary, markdown)
    return [name, detail, body].filter(Boolean).join('\n')
  })

  const header = markdown
    ? (totalPages > 1 ? `🗂 **Sessions** (page ${page}/${totalPages})` : '🗂 **Sessions**')
    : (totalPages > 1 ? `Sessions (page ${page}/${totalPages})` : 'Sessions (most recent first)')

  const hints: string[] = []
  if (page < totalPages) {
    hints.push(markdown ? `Next: \`/sessions ${page + 1}\`` : `Next: /sessions ${page + 1}`)
  }
  hints.push(markdown ? 'Use `/resume <id>` to switch.' : 'Use /resume <id> to switch.')

  return [
    header,
    ...entries,
    hints.join(' · '),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * A one-line summary for a session listing. A session's recap covers 3 to 5
 * bullets — what it was about, decisions settled, paths and commands, open
 * items — but in a list of up to ten sessions, quoting the full digest across
 * every one makes the message gigantic. We show only the first bullet (what it
 * was about) and fall back to the preview of the first message.
 */
export function summarizeRecap(recap: string | undefined, preview: string, limit = 120): string {
  if (recap) {
    const first = recap
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    if (first) {
      const clean = first.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim()
      if (clean) {
        return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean
      }
    }
  }
  return preview
}

/** A block of lines as a Markdown quote, or indented for a plain-text surface. */
function quote(text: string, markdown: boolean): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => (markdown ? `> ${line}` : `  ${line}`))
    .join('\n')
}

export function formatStats(stats: SessionStats): string {
  const name = stats.title ? `${stats.id} — ${stats.title}` : stats.id
  // The ceiling the request is measured against, so the count means something:
  // the CLI shows the same pair, and a token number with no ceiling says nothing
  // about whether the session is anywhere near compaction.
  const used = stats.tokens + (stats.fixedTokens ?? 0)
  const ceiling = stats.maxInputTokens ? ` of ${stats.maxInputTokens}` : ''
  const lines = [
    `Session ${name}`,
    `started ${formatWhen(stats.createdAt)} · last activity ${formatWhen(stats.updatedAt)}`,
    `${stats.messages} messages · ${stats.turns} turns · ~${used}${ceiling} tokens`,
  ]
  if (stats.compacted) {
    const amount = stats.droppedTokens ? ` (~${stats.droppedTokens} tokens summarized)` : ''
    lines.push(`compacted${amount}`)
  }
  return lines.join('\n')
}
