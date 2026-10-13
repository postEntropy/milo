export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : JSON.stringify(value))
}

export function errorMessage(value: unknown): string {
  return describe(toError(value))
}

/**
 * Whether the error means "the caller stopped us". A cancelled fetch rejects
 * with an `AbortError`, but the signal is checked too: a provider is free to
 * fail in its own way once the request is already gone.
 */
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * An error and whatever caused it, as one line. A transport's own word says little
 * by itself: Node's fetch reports a stream the far end stopped feeding as
 * `terminated`, and the socket error or timeout that ended it rides in `cause`,
 * where it was being dropped.
 */
function describe(error: Error): string {
  const cause = error.cause
  const inner = cause instanceof Error ? describe(cause) : typeof cause === 'string' ? cause : ''
  return inner ? `${error.message} (${inner})` : error.message
}
