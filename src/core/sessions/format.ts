import type { SessionStats, SessionSummary } from './types.js'

const MAX_LISTED = 10

export interface SessionListStyle {
  /** Render for a surface that understands Markdown (Telegram rich, Discord). */
  markdown?: boolean
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

  if (sessions.length === 0) {
    return markdown
      ? '🗂 **Sessions**\n\nNothing saved yet. `/new` starts one.'
      : 'Sessions\n\nNothing saved yet. /new starts one.'
  }

  const entries = sessions.slice(0, MAX_LISTED).map((session) => {
    const label = session.title ? `${session.id} — ${session.title}` : session.id
    const name = markdown ? `**${label}**` : label
    const meta = `${session.messageCount} msgs · ${formatWhen(session.updatedAt)}`
    const detail = markdown ? meta : `  ${meta}`
    const preview = session.preview ? (markdown ? `> ${session.preview}` : `  ${session.preview}`) : ''
    return [name, detail, preview].filter(Boolean).join('\n')
  })

  const more =
    sessions.length > MAX_LISTED ? `… and ${sessions.length - MAX_LISTED} more` : undefined
  const hint = markdown
    ? 'Use `/resume <id>` to switch.'
    : 'Use /resume <id> to switch.'

  return [
    markdown ? '🗂 **Sessions**' : 'Sessions (most recent first)',
    ...entries,
    more,
    hint,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function formatStats(stats: SessionStats): string {
  const name = stats.title ? `${stats.id} — ${stats.title}` : stats.id
  const system =
    stats.systemTokens === undefined ? '' : ` · ~${stats.systemTokens} tokens of system prompt`
  const lines = [
    `Session ${name}`,
    `started ${formatWhen(stats.createdAt)} · last activity ${formatWhen(stats.updatedAt)}`,
    `${stats.messages} messages · ${stats.turns} turns · ~${stats.tokens} tokens in context${system}`,
  ]
  if (stats.compacted) {
    const amount = stats.droppedTokens ? ` (~${stats.droppedTokens} tokens summarized)` : ''
    lines.push(`compacted${amount}`)
  }
  return lines.join('\n')
}
