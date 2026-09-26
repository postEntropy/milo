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
