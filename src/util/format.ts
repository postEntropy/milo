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
  // Only at a separator: `/home/leonardo2` is not inside `/home/leonardo`, and
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
