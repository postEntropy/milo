/**
 * Runs one turn at a time per conversation.
 *
 * A gateway must never wait for a turn inside its update handler. A turn blocks
 * until the user answers a permission prompt, and Telegram's simple long polling
 * handles updates one at a time (`handleUpdates` awaits each one), so the button
 * press would sit in the queue behind the very turn waiting for it — a deadlock
 * that ends in a timeout and a denied tool. The queue keeps the handler free
 * while still stopping two turns from mutating the same session at once.
 */
export class TurnQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  /** Queues `work` behind whatever is already running for `key`. */
  run(key: string, work: () => Promise<void>): void {
    const previous = this.tails.get(key) ?? Promise.resolve()
    // Never rejects: a failed turn must not poison the queue for the next one.
    const next = previous.then(work).catch(() => undefined)
    this.tails.set(key, next)
    void next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key)
    })
  }

  /** Conversations with a turn running or queued. */
  get size(): number {
    return this.tails.size
  }
}
