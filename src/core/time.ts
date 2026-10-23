const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const pad = (value: number): string => String(value).padStart(2, '0')

/** The time of day, always on the 24-hour clock: 21:05, never 9:05 PM. */
function clock(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A calendar day as one comparable number, so a month or a year rolls over. */
function dayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY
}

/** The day of a point, as a person reads it: Today, Yesterday, or 22/10/2026. */
function dayLabel(date: Date, now: Date): string {
  const day = dayNumber(date)
  const today = dayNumber(now)
  if (day === today) return 'Today'
  if (day === today - 1) return 'Yesterday'
  if (day === today + 1) return 'Tomorrow'
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

/**
 * When something happened, as every surface says it: `10 min ago` while it is
 * fresh, `2h ago` later the same day, `Yesterday`, and `22/10/2026` beyond that.
 * The day is written day-first, and the clock is 24-hour, on every surface that
 * draws a time — the terminal, the chat gateways and the browser alike.
 *
 * `absolute` names the instant rather than the distance: `Today, 21:05`,
 * `Yesterday, 21:05`, `22/10/2026, 21:05` — for a run, a message, or a schedule
 * whose own time is the thing being read.
 */
export function formatWhen(timestamp: number, style: 'relative' | 'absolute' = 'relative'): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (style === 'absolute') return `${dayLabel(date, now)}, ${clock(date)}`
  const elapsed = now.getTime() - timestamp
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (dayNumber(date) === dayNumber(now)) return `${Math.floor(elapsed / HOUR)}h ago`
  if (dayNumber(now) - dayNumber(date) === 1) return 'Yesterday'
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

/**
 * The same instant written into a record that outlives the moment it was made —
 * an exported transcript, a log line: `2026-10-22 21:05`. Unambiguous and
 * sortable, and never relative, because "10 min ago" means nothing to whoever
 * opens the file tomorrow.
 */
export function formatStamp(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock(date)}`
}

/** How long until a time that has not come yet: `in 3 min`, `in 2h`, `in 5d`. */
export function formatIn(timestamp: number): string {
  const ahead = timestamp - Date.now()
  if (ahead <= 0) return 'any moment'
  if (ahead < MINUTE) return 'in under a minute'
  if (ahead < HOUR) return `in ${Math.round(ahead / MINUTE)} min`
  if (ahead < DAY) return `in ${Math.round(ahead / HOUR)}h`
  return `in ${Math.round(ahead / DAY)}d`
}
