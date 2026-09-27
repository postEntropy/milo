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

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
