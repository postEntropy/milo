import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * How long a turn has been running. `ms` is null until a turn starts; while one runs it
 * moves, because the wait is the thing being watched — and the time is written under the
 * answer it belongs to, so two answers can be read against each other. `stop` hands back
 * the total, so the message keeps it after the turn is over.
 *
 * The wording of that number is `formatSeconds` in the core, which the terminal's status
 * band reads too: the two surfaces tick differently, but they say the same thing about
 * the same wait.
 */
export function useTurnClock(): { ms: number | null; start: () => void; stop: () => number } {
  const [ms, setMs] = useState<number | null>(null)
  const from = useRef(0)
  const timer = useRef<number | null>(null)

  const halt = useCallback((): void => {
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = null
  }, [])

  const start = useCallback((): void => {
    halt()
    from.current = Date.now()
    setMs(0)
    timer.current = window.setInterval(() => setMs(Date.now() - from.current), 100)
  }, [halt])

  const stop = useCallback((): number => {
    // A turn that ended without one starting says nothing, rather than inventing a
    // duration out of whatever the last turn left in the ref.
    if (timer.current === null) return 0
    halt()
    const total = Date.now() - from.current
    setMs(total)
    return total
  }, [halt])

  useEffect(() => halt, [halt])

  return { ms, start, stop }
}
