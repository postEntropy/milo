import { formatDuration } from '../util/format.js'
import { logWarn } from '../util/log.js'
import type { TraceWriter } from './traces.js'

/**
 * How long a turn with no output at all is reported in the daemon's log. Long
 * enough that a slow model still thinking is not news; short enough that a
 * person watching a spinner is not left alone with it.
 */
export const WATCHDOG_REPORT_MS = 5 * 60_000

/**
 * How long it is left to produce something before it is stopped.
 *
 * A turn holds its session's lease for as long as it runs, and a stream that
 * goes quiet — a socket the far end stopped feeding, a tool that never returns —
 * never ends on its own: the session stays busy on every surface, and the next
 * message waits behind a turn that is not working. Stopping it is the same end a
 * `/stop` gives it, so the transcript is answered and valid and the lease goes
 * back.
 */
export const WATCHDOG_STOP_MS = 15 * 60_000

/** How often the daemon looks. */
const DEFAULT_TICK_MS = 30_000

interface Watched {
  sessionId: string
  /** The turn's own controller, the one this watchdog may stop. */
  abort: AbortController
  lastAt: number
  reportedAt?: number
  stopped: boolean
}

/**
 * The watch over the turns a process is running.
 *
 * It exists because a stuck turn is invisible from the inside: the loop is
 * awaiting something that will never answer, so nothing is written, nothing is
 * shown, and the failure takes the shape of silence. This is the outside look —
 * a turn that has produced nothing for a while is said out loud, and one that has
 * produced nothing for much longer is stopped rather than waited on forever.
 *
 * It watches the turns of this process only, which is the honest scope: another
 * Milo's turn holds the lease, and its own process watches it. A terminal is not
 * given a timer at all — the person is at the keyboard, and Ctrl+C is a better
 * stop than a guess.
 */
export class TurnWatchdog {
  private readonly turns = new Map<string, Watched>()
  private readonly traces?: TraceWriter
  private timer?: ReturnType<typeof setInterval>

  constructor(options: { traces?: TraceWriter } = {}) {
    this.traces = options.traces
  }

  /**
   * Watches one turn. The detach returned stops watching it, and is safe to call
   * after the turn already ended. A turn is keyed by its session, and two turns
   * never run on one session at once.
   */
  watch(sessionId: string, abort: AbortController): () => void {
    const watched: Watched = { sessionId, abort, lastAt: Date.now(), stopped: false }
    this.turns.set(sessionId, watched)
    return () => {
      if (this.turns.get(sessionId) === watched) this.turns.delete(sessionId)
    }
  }

  /** The turn said something: a token, a tool starting, a step boundary. */
  touch(sessionId: string): void {
    const watched = this.turns.get(sessionId)
    if (watched) watched.lastAt = Date.now()
  }

  /** Starts the periodic pass. Safe to call twice; the second call does nothing. */
  start(tickMs: number = DEFAULT_TICK_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * One pass, at `now`. Report first, stop later: a turn that is merely slow gets
   * its line in the log and its chance to answer, and only the one that has been
   * silent past the stop threshold is ended.
   */
  tick(now: number = Date.now()): void {
    for (const watched of [...this.turns.values()]) {
      if (watched.stopped) continue
      const idle = now - watched.lastAt
      if (idle >= WATCHDOG_STOP_MS) {
        watched.stopped = true
        this.traces?.record({
          at: new Date().toISOString(),
          event: 'watchdog',
          ok: false,
          ms: idle,
          session: watched.sessionId,
          reason: 'stalled',
        })
        logWarn(`stopped a turn on ${watched.sessionId}: nothing for ${formatDuration(idle)}`)
        watched.abort.abort(new Error(`the turn produced nothing for ${formatDuration(idle)}`))
        continue
      }
      if (idle < WATCHDOG_REPORT_MS || watched.reportedAt !== undefined) continue
      watched.reportedAt = now
      logWarn(
        `turn on ${watched.sessionId} has produced nothing for ${formatDuration(idle)}; ` +
          `stopping it at ${formatDuration(WATCHDOG_STOP_MS)}`,
      )
    }
  }
}
