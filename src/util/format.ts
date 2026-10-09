/**
 * A size as a person reads it. One decimal is the right amount — two is a
 * precision nobody asked for, none loses the difference between 1.4 and 1.9 MB —
 * and a trailing `.0` is no precision at all: `448.0 KB` reads as a machine
 * reporting a number it did not have.
 */
export function humanSize(bytes: number): string {
  const unit = bytes < 1024 ? 'B' : bytes < 1024 * 1024 ? 'KB' : 'MB'
  const value = unit === 'B' ? bytes : bytes / (unit === 'KB' ? 1024 : 1024 * 1024)
  const rounded = unit === 'B' ? String(value) : value.toFixed(1).replace(/\.0$/, '')
  return `${rounded} ${unit}`
}

/** A path as a person writes it: under the home directory, that is `~`. */
export function shortenPath(target: string, home: string): string {
  if (!home || !target.startsWith(home)) return target
  const rest = target.slice(home.length)
  if (rest === '') return '~'
  // Only at a separator: `/home/user2` is not inside `/home/user`, and
  // `~2/foo` is a path that leads nowhere.
  return rest.startsWith('/') || rest.startsWith('\\') ? `~${rest}` : target
}

/**
 * A count with its noun. `2 turns` and `1 turns` in the same document is the
 * kind of thing that makes a readout look machine-written — and `turn(s)` is a
 * way of not choosing, which reads no better.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * An answer closed with a paragraph break, so what comes next — the text after a
 * tool call, a routine's report, a subagent's result — starts its own paragraph
 * instead of running into the sentence before it.
 *
 * One rule for the three places that accumulate a turn's text: the session's own
 * log, a routine and a subagent all draw the same answer, so all three have to
 * break it in the same place. (The web's live transcript is not one of them: it
 * keeps prose and tool lines as ordered parts, so a tool call already ends the
 * paragraph it followed.)
 */
export function closeParagraph(text: string): string {
  if (!text) return text
  if (text.endsWith('\n\n')) return text
  return text.endsWith('\n') ? `${text}\n` : `${text}\n\n`
}

/**
 * A duration as a person reads it: `8s`, `2m 10s`, `1h 3m`. Shared by every
 * place a wait or a running job is shown, so the same span cannot read two ways
 * on two surfaces.
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
}
