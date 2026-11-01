import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../src/core/traces.js'
import { TurnWatchdog, WATCHDOG_REPORT_MS, WATCHDOG_STOP_MS } from '../src/core/watchdog.js'

// The clock the watch reads is `Date.now()`, so the test owns it: a turn that
// went quiet ten minutes ago is not something a real stopwatch can schedule.
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

function recorder(): { events: TraceEvent[]; traces: { record(entry: TraceEvent): void } } {
  const events: TraceEvent[] = []
  return { events, traces: { record: (entry) => events.push(entry) } }
}

describe('the watchdog over a turn', () => {
  it('leaves a turn that is still producing alone', () => {
    const watchdog = new TurnWatchdog()
    const turn = new AbortController()
    const t0 = 1_000_000
    watchdog.watch('calm-otter-7', turn)

    watchdog.tick(t0 + WATCHDOG_REPORT_MS - 1)

    expect(turn.signal.aborted).toBe(false)
  })

  it('reports a silent turn before it stops it', () => {
    const { events, traces } = recorder()
    const watchdog = new TurnWatchdog({ traces })
    const turn = new AbortController()
    const t0 = 1_000_000
    watchdog.watch('calm-otter-7', turn)

    watchdog.tick(t0 + WATCHDOG_REPORT_MS)
    expect(turn.signal.aborted).toBe(false)
    expect(events).toEqual([])

    watchdog.tick(t0 + WATCHDOG_STOP_MS)
    expect(turn.signal.aborted).toBe(true)
    expect(events.map((event) => event.event)).toEqual(['watchdog'])
    expect(events[0]).toMatchObject({ ok: false, session: 'calm-otter-7', reason: 'stalled' })
  })

  it('counts from the turn\'s last piece of news, not from when it started', () => {
    const watchdog = new TurnWatchdog()
    const turn = new AbortController()
    const t0 = 1_000_000
    watchdog.watch('calm-otter-7', turn)

    watchdog.tick(t0 + WATCHDOG_REPORT_MS)
    // A token arrives: the silence that mattered is over, and the count that
    // matters is the one from here.
    const touchedAt = t0 + WATCHDOG_REPORT_MS + 1_000
    vi.setSystemTime(touchedAt)
    watchdog.touch('calm-otter-7')
    watchdog.tick(touchedAt + WATCHDOG_STOP_MS - 1)

    expect(turn.signal.aborted).toBe(false)
  })

  it('forgets a turn that has ended, so its session is not stopped later', () => {
    const watchdog = new TurnWatchdog()
    const turn = new AbortController()
    const t0 = 1_000_000
    const detach = watchdog.watch('calm-otter-7', turn)
    detach()

    watchdog.tick(t0 + WATCHDOG_STOP_MS * 2)

    expect(turn.signal.aborted).toBe(false)
  })

  it('records one stop, not one per pass', () => {
    const { events, traces } = recorder()
    const watchdog = new TurnWatchdog({ traces })
    const turn = new AbortController()
    const t0 = 1_000_000
    watchdog.watch('calm-otter-7', turn)

    watchdog.tick(t0 + WATCHDOG_STOP_MS)
    watchdog.tick(t0 + WATCHDOG_STOP_MS * 2)

    expect(events).toHaveLength(1)
  })
})
