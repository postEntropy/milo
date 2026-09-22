import { useEffect, useState } from 'react'

/**
 * Returns the seconds elapsed since `start`, re-rendering on an interval while
 * `active` is true. Returns 0 when inactive.
 */
export function useElapsed(active: boolean, start: number): number {
  const [, force] = useState(0)

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => force((value) => value + 1), 150)
    return () => clearInterval(id)
  }, [active])

  return active ? Math.max(0, (Date.now() - start) / 1000) : 0
}
