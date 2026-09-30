import { useCallback, useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copies text and says what happened.
 *
 * A clipboard that refuses — an insecure origin, a document that was not focused,
 * a browser wanting a gesture it did not get — is reported rather than swallowed:
 * a button that answers a press with nothing at all reads as a broken button, and
 * the reader is left believing the text is on the clipboard when it is not.
 *
 * The timer is cleared on the way out, so a control that unmounts mid-flash
 * cannot set state on a component that is gone.
 */
export function useCopy(text: string): { state: CopyState; copy(): void } {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = useCallback((): void => {
    window.clearTimeout(timer.current)
    navigator.clipboard.writeText(text).then(
      () => {
        setState('copied')
        timer.current = window.setTimeout(() => setState('idle'), 2000)
      },
      () => setState('failed'),
    )
  }, [text])

  return { state, copy }
}
