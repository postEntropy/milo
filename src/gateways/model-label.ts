/**
 * The model without its vendor prefix: `deepseek/deepseek-v4.1-flash` reads as
 * `deepseek-v4.1-flash`, since the provider beside it already says where the
 * request goes and the row has only one line to spend.
 *
 * Shared rather than copied, so the terminal and the web cannot drift. The full
 * id stays wherever it matters — `/model`, the sessions list, the wire.
 */
export function shortModel(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}

/**
 * How much a model holds, for a row that has one line for it: `128k`, `1M`.
 * Rounded, because nobody compares the last digit of a context window.
 */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return `${tokens}`
}

/**
 * The second line of a model row: how much it holds, then what it is called. The
 * size leads because it is what tells two models of the same family apart, and
 * a row is read from its own edge inward.
 */
export function modelNote(model: { name?: string; context?: number }): string | undefined {
  const parts = [model.context ? formatContext(model.context) : undefined, model.name].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}
