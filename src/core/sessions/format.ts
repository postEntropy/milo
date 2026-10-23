import type { AgentEvent } from '../agent/events.js'
import { formatWhen } from '../time.js'
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

/**
 * What a fold came to, as one sentence every surface draws: the turns that went,
 * what they were worth in estimated tokens, and how long the summary call took.
 *
 * Whether a summary was written is part of the answer and not a detail: the turns
 * go either way, because a request that fits beats one the provider rejects — so a
 * person told only "compacted" has been told something that did not happen.
 */
export function describeCompaction(fold: {
  folded: number
  tokens: number
  ms: number
  summarized: boolean
}): string {
  const turns = `${fold.folded} turn${fold.folded === 1 ? '' : 's'}`
  const took = fold.ms >= 1000 ? formatSeconds(fold.ms / 1000) : `${fold.ms}ms`
  return fold.summarized
    ? `🗜 Compacted: ${turns} (~${fold.tokens} tokens) folded into the summary in ${took}.`
    : `🗜 Compacted: ${turns} (~${fold.tokens} tokens) dropped — the summary call failed, so nothing was written in their place. In ${took}.`
}

/**
 * Where a turn is, in the words a surface that reads prose shows — the browser and the
 * phone. Said here, once: both drew these sentences from their own copies, and the
 * phone's had already drifted from the browser's with nothing holding the two together.
 *
 * The terminal and the chat bots do not read this. They say the same facts in their own
 * register — `⏳ another Milo is using this session` — which is a different sentence for a
 * different medium, and they take their ingredients from the functions above.
 *
 * `undefined` where there is nothing to say: a turn that finished normally is not news,
 * and a caller that reads one clears the line it was on.
 */
export function statusText(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'waiting':
      return 'Waiting for this session to free up…'
    case 'waited':
      return `Session freed after ${formatSeconds(event.ms / 1000)}.`
    case 'compacting':
      return 'Tidying the context…'
    case 'compacted':
      return describeCompaction(event)
    case 'rebased':
      return `Session updated by another surface (${describeRebase(event)}).`
    case 'steer':
      return 'Correction received by Milo.'
    case 'aborted':
      return 'Stopped · the partial reply was kept.'
    case 'done':
      // A capped answer otherwise reads as a complete one.
      return event.finishReason === 'length' ? 'The reply hit the output limit.' : undefined
    case 'error':
      return `Error: ${event.message}`
    default:
      return undefined
  }
}

export interface SessionListStyle {
  /** Render for a surface that understands Markdown (Telegram, Discord). */
  markdown?: boolean
  /** 1-based page number. Defaults to 1. */
  page?: number
  /** Number of sessions per page. Defaults to 5. */
  pageSize?: number
  /**
   * How a session's project is named, when the surface drawing the list knows the
   * projects. Absent — a surface that was not handed them — leaves the project
   * out rather than showing the id it is kept by.
   */
  projectName?: (id: string) => string | undefined
}

/**
 * A span of seconds as both surfaces say it: a tenth of a second matters at 6.4s,
 * and at 51s it is noise. The terminal's status band and the web's turn clock read
 * it from here, so the same wait is not two different numbers across the two.
 */
export function formatSeconds(seconds: number): string {
  return `${seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds)}s`
}

/**
 * What a session is called on screen: the name it was given, or the words it
 * opened with. One rule for every surface — the terminal, the chat gateways, the
 * browser and the phone — because a session drawn as its own id while another
 * surface shows what it was about is the same session under two names.
 */
export function sessionLabel(session: { title?: string; preview?: string }): string {
  return session.title || session.preview || ''
}

/**
 * What a session's row is called: the name it was given, the words it opened with, what it
 * was found to be about, or one word for a session nothing was said in yet.
 *
 * The daemon composes it, once, because the browser and the phone each did: the phone's copy
 * dropped the recap and fell back on a different word, so the same session read under two
 * names. The listing keeps `sessionLabel` — it draws the recap as the body below and would
 * otherwise say the same thing twice.
 */
export function sessionRowLabel(session: { title?: string; preview?: string; recap?: string }): string {
  return sessionLabel(session) || session.recap || 'New session'
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
    // The id leads, because it is what `/resume` takes; the name follows. A
    // session with neither a name nor a message yet is the id alone.
    const label = sessionLabel(session)
    const named = label ? `${session.id} — ${label}` : session.id
    // A session that moved after it was last looked at leads with the mark, in the
    // plain listing and the Markdown alike — the same ● the terminal draws, since
    // both are read in a chat. Outside the bold so the mark itself is not shouted.
    const mark = session.unread ? '● ' : ''
    const name = markdown ? `${mark}**${named}**` : `${mark}${named}`
    // A session working in a project says which one, before the size and the
    // time: it is the context the other two are read in, and the same list is
    // drawn by every surface.
    const project = session.project ? style.projectName?.(session.project) : undefined
    const meta = [project, `${session.messageCount} msgs`, formatWhen(session.updatedAt)]
      .filter(Boolean)
      .join(' · ')
    const detail = markdown ? meta : `  ${meta}`
    // The recap says what the session was about; the preview is the fallback for
    // one that was never switched away from, so it never got one. In a listing of
    // sessions, only the first bullet of the recap is shown so replies do not
    // outgrow the chat. A session with no recap and no name says it in the label
    // already — the body is left out rather than repeating the same line.
    const summary = session.recap
      ? summarizeRecap(session.recap, session.preview)
      : (session.title ? session.preview : '')
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

/**
 * The words a person picked out of an answer, as they lead the reply to it: every
 * line quoted, then the blank line that separates them from what is said back. The
 * browser's composer and the phone build their message from this one shape, so a
 * quotation reads the same on both.
 *
 * Unlike `quote()` above, nothing is dropped: an empty line inside what was picked
 * out stays a quoted empty line, because these are the words themselves and not a
 * report of them.
 */
export function quotedLead(text: string): string {
  const quoted = text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${quoted}\n\n`
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
