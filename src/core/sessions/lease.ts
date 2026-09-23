/**
 * One holder per key, within this process.
 *
 * The cross-process half — a lock beside the session record — lives in the file
 * store; this is what the in-memory store has instead, and what keeps a process
 * from queueing behind its own file lock. Both exist so that "one turn per
 * session" holds whether the second turn is another conversation in this process
 * or another terminal entirely.
 */
export class KeyedMutex {
  /** Per key, a promise that settles when the current holder releases. */
  private readonly chains = new Map<string, Promise<void>>()

  /** Takes `key`, waiting for whoever holds it. Resolves with the release. */
  async acquire(key: string): Promise<() => void> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const release = this.enqueue(key, previous)
    await previous
    return release
  }

  /** Takes `key` only if it is free; null when someone else holds it. */
  tryAcquire(key: string): (() => void) | null {
    if (this.chains.has(key)) return null
    return this.enqueue(key, Promise.resolve())
  }

  private enqueue(key: string, previous: Promise<void>): () => void {
    let unlock!: () => void
    const held = new Promise<void>((resolve) => {
      unlock = resolve
    })
    // The next waiter is handed this link, so it resolves only once we let go.
    const link = previous.then(() => held)
    this.chains.set(key, link)
    return () => {
      // Freed here rather than on a later microtask: a caller that releases and
      // asks again in the same tick has to find the key free. A waiter queued
      // behind us has already replaced the entry, so this only drops our own.
      if (this.chains.get(key) === link) this.chains.delete(key)
      unlock()
    }
  }
}

function abortError(): Error {
  const error = new Error('the wait was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Awaits `take`, giving up the moment `signal` aborts — so a stopped turn does
 * not sit invisibly behind another one. A lease that arrives after the wait was
 * abandoned is released at once: a cancelled wait must never keep a lock.
 */
export async function waitForLease<T extends () => void>(
  take: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return take
  const abandon = () => {
    void take.then(
      (release) => release(),
      () => undefined,
    )
  }
  if (signal.aborted) {
    abandon()
    throw abortError()
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      abandon()
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    take.then(
      (release) => {
        signal.removeEventListener('abort', onAbort)
        resolve(release)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
