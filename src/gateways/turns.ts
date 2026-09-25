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
 *
 * The queue is also what can stop a turn, which is why it owns the abort handle:
 * the handle has to exist for as long as the turn does, and the queue is the one
 * place that knows when a turn starts and when it is over.
 */
export class TurnQueue {
  private readonly tails = new Map<string, Promise<unknown>>()
  /** The turn running right now: the inbox it reads, and its abort handle. */
  private readonly running = new Map<string, { inbox: string[]; controller: AbortController }>()
  /** Turns registered and not finished, the running one included. */
  private readonly registered = new Map<string, number>()
  /**
   * Bumped by `stop`. A turn queued before the bump is skipped when its turn
   * comes: `/stop` means stop, not "stop this one and start the next message of
   * the queue you already sent".
   */
  private readonly epoch = new Map<string, number>()

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
    const turn = this.running.get(key)
    if (!turn) return false
    turn.inbox.push(text)
    return true
  }

  /** True while a turn is running for `key` — queued is not running. */
  busy(key: string): boolean {
    return this.running.has(key)
  }

  /** How many turns are waiting behind the running one. */
  queued(key: string): number {
    const registered = this.registered.get(key) ?? 0
    return Math.max(0, registered - (this.running.has(key) ? 1 : 0))
  }

  /**
   * Stops what is running for `key`, now: the model call in flight is aborted
   * and the tool call with it. What was queued behind it goes too — stopping one
   * turn only to start the next message of the queue is not what `/stop` means.
   *
   * A message sent after the stop runs normally, which is what makes this usable
   * as "that was not what I wanted" rather than as a kill switch.
   */
  stop(key: string): { stopped: boolean; dropped: number } {
    const turn = this.running.get(key)
    if (!turn) return { stopped: false, dropped: 0 }
    this.epoch.set(key, (this.epoch.get(key) ?? 0) + 1)
    turn.controller.abort()
    return { stopped: true, dropped: this.queued(key) }
  }

  /** Queues `work` behind whatever is already running for `key`. */
  run(key: string, work: (inbox: string[], signal: AbortSignal) => Promise<void>): void {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const epoch = this.epoch.get(key) ?? 0
    this.registered.set(key, (this.registered.get(key) ?? 0) + 1)

    const next = previous
      .then(async () => {
        // Queued before a stop: that stop was the answer to these too.
        if ((this.epoch.get(key) ?? 0) !== epoch) return
        const controller = new AbortController()
        const inbox: string[] = []
        // Registered before the first await inside `work`, so a message arriving
        // as the turn starts is steered into it rather than missed.
        this.running.set(key, { inbox, controller })
        try {
          await work(inbox, controller.signal)
        } finally {
          this.running.delete(key)
        }
      })
      // Never rejects: a failed turn must not poison the queue for the next one.
      .catch((error: unknown) => logWarn(`turn failed: ${errorMessage(error)}`))
      .finally(() => {
        const left = (this.registered.get(key) ?? 1) - 1
        if (left > 0) this.registered.set(key, left)
        else this.registered.delete(key)
      })

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
