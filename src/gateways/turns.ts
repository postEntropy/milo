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
  /**
   * Turns waiting behind another one. A turn with nothing ahead of it runs as
   * soon as it is registered, so it is never counted here — the tail alone
   * cannot tell a turn that runs at once from one that waits its turn.
   */
  private readonly waiting = new Map<string, number>()
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
    return this.waiting.get(key) ?? 0
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

  /**
   * Queues `work` behind whatever is already running for `key`.
   *
   * `onSettled` runs once the turn is over **and the queue has let it go** — a
   * moment `work` itself cannot see, because `busy` stays true for as long as it
   * runs. Deliberately a callback and not a returned promise: this class exists so
   * that no gateway ever awaits a turn in its update handler (the Telegram
   * deadlock above), and a promise is exactly the offer that ends in one.
   */
  run(
    key: string,
    work: (inbox: string[], signal: AbortSignal) => Promise<void>,
    onSettled?: () => void,
  ): void {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const epoch = this.epoch.get(key) ?? 0
    // A turn already on the tail is ahead of this one, so it waits — and waiting
    // is the only thing that makes it queued. A turn with nothing ahead runs at
    // once, and reporting it as queued is a lie the state frame shows on screen.
    const waiting = this.tails.has(key)
    if (waiting) this.waiting.set(key, (this.waiting.get(key) ?? 0) + 1)

    const next = previous
      .then(async () => {
        // Only a turn that was counted as waiting leaves the count when it
        // starts. The first turn was never in it, and taking a slot out here
        // would steal the next message's.
        if (waiting) this.dequeue(key)
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

    this.tails.set(key, next)
    void next.then(() => {
      if (this.tails.get(key) === next) this.tails.delete(key)
    })
    if (onSettled) {
      // On the same promise, so it runs for a turn that failed as well — a surface
      // still has to be told the turn is over — and after the queue has forgotten
      // it, which is the whole reason this is not read from inside `work`.
      void next.then(() => {
        try {
          onSettled()
        } catch (error) {
          logWarn(`turn settle handler failed: ${errorMessage(error)}`)
        }
      })
    }
  }

  /** One fewer turn is waiting: this one is starting, or a stop dropped it. */
  private dequeue(key: string): void {
    const left = (this.waiting.get(key) ?? 0) - 1
    if (left > 0) this.waiting.set(key, left)
    else this.waiting.delete(key)
  }

  /** Conversations with a turn running or queued. */
  get size(): number {
    return this.tails.size
  }
}
