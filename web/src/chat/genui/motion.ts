import { useEffect, useRef, useState } from 'react'

/** Whether the person asked the system for less motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const listen = (): void => setReduced(query.matches)
    query.addEventListener('change', listen)
    return () => query.removeEventListener('change', listen)
  }, [])
  return reduced
}

/**
 * A number that travels to its next value instead of jumping — the figure a `stat`
 * or a `progress` shows counts to what the inputs now say.
 *
 * It runs when the value changes, never when the widget merely re-renders: a draft
 * arrives up to ten times a second and a count-up keyed to that would twitch.
 */
export function useCountUp(value: number, ms = 420): number {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const frame = useRef(0)

  useEffect(() => {
    if (reduced || !Number.isFinite(value)) {
      from.current = value
      setShown(value)
      return
    }
    const origin = from.current
    const started = performance.now()
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / ms)
      const eased = 1 - (1 - t) ** 3
      setShown(origin + (value - origin) * eased)
      if (t < 1) frame.current = requestAnimationFrame(step)
      else from.current = value
    }
    frame.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame.current)
  }, [value, ms, reduced])

  return shown
}
