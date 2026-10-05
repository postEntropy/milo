import { useCallback, useEffect, useRef, useState } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copies text and says what happened.
 *
 * The async Clipboard API exists only in a secure context — localhost, or HTTPS —
 * so a page reached by a LAN address, which is how the web app is opened on a
 * phone, has no `navigator.clipboard` at all. Reading through it anyway threw
 * before the promise was ever made, and a button that answers a press with
 * nothing reads as a broken button: the reader is left believing the text is on
 * the clipboard when it is not. So the selection-based route is used whenever the
 * async one is missing or refuses.
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
    void copyText(text).then((copied) => {
      if (!copied) {
        setState('failed')
        return
      }
      setState('copied')
      timer.current = window.setTimeout(() => setState('idle'), 2000)
    })
  }, [text])

  return { state, copy }
}

/** Puts `text` on the clipboard and says whether it landed. */
async function copyText(text: string): Promise<boolean> {
  const clipboard: Clipboard | undefined = navigator.clipboard
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // A refusal here — a document that lost focus, a denied permission — is not
      // necessarily fatal: the selection-based route may still take it.
    }
  }
  return copyBySelection(text)
}

/**
 * The route that predates the Clipboard API: put the text in a selection and ask
 * the document to copy it. It is the one an insecure origin — the page opened by
 * a LAN address — still has.
 */
function copyBySelection(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  // Off-screen but still selectable; a fixed box keeps the page from jumping to it.
  area.style.position = 'fixed'
  area.style.left = '-9999px'
  try {
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    // `remove` is a no-op when the append never happened, so this cannot throw.
    area.remove()
  }
}
