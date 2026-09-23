import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'

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
  /** The inbox of the turn running right now, if any, per conversation. */
  private readonly inboxes = new Map<string, string[]>()

  /**
   * Hands `text` to the turn already running for `key`, instead of starting a
   * second one. It is taken up at the next step boundary — after the tool call
   * in flight — so it reads as a correction rather than as a race.
   *
   * Returns false when no turn is running: there is nobody to give it to, and
   * the caller starts one. A message that lands in the moment between two turns
   * therefore becomes its own turn; losing it would be the worse answer.
   */
  steer(key: string, text: string): boolean {
    const inbox = this.inboxes.get(key)
    if (!inbox) return false
    inbox.push(text)
    return true
  }

  /** True while a turn is running for `key` — queued is not running. */
  busy(key: string): boolean {
    return this.inboxes.has(key)
  }

  /** Queues `work` behind whatever is already running for `key`. */
  run(key: string, work: (inbox: string[]) => Promise<void>): void {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        // Registered before the first await inside `work`, so a message arriving
        // as the turn starts is steered into it rather than missed.
        const inbox: string[] = []
        this.inboxes.set(key, inbox)
        try {
          await work(inbox)
        } finally {
          this.inboxes.delete(key)
        }
      })
      // Never rejects: a failed turn must not poison the queue for the next one.
      .catch((error: unknown) => logWarn(`turn failed: ${errorMessage(error)}`))
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
