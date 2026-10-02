export function splitNames(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Absolute for a next run, relative for a past one. */
export function formatWhen(timestamp: number, absolute = false): string {
  if (absolute) return new Date(timestamp).toLocaleString()
  const elapsed = Date.now() - timestamp
  const minute = 60_000
  const hour = minute * 60
  const day = hour * 24
  if (elapsed < minute) return 'just now'
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} min ago`
  if (elapsed < day) return `${Math.floor(elapsed / hour)} h ago`
  if (elapsed < day * 7) return `${Math.floor(elapsed / day)} d ago`
  return new Date(timestamp).toLocaleDateString()
}

/** How long until a time that has not come yet: `in 3 min`, `in 2 h`, `in 5 d`. */
export function formatIn(timestamp: number): string {
  const ahead = timestamp - Date.now()
  const minute = 60_000
  const hour = minute * 60
  const day = hour * 24
  if (ahead <= 0) return 'any moment'
  if (ahead < minute) return 'in under a minute'
  if (ahead < hour) return `in ${Math.round(ahead / minute)} min`
  if (ahead < day) return `in ${Math.round(ahead / hour)} h`
  return `in ${Math.round(ahead / day)} d`
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A token count, short enough for a line in the interface. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`
  if (count >= 1_000) return `${Math.round(count / 100) / 10}k`
  return `${count}`
}
