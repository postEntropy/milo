import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons.js'

/**
 * A picture, over the app, as large as the screen allows.
 *
 * Three ways out — the X, the scrim behind it and Escape — and nothing else drawn
 * over the picture, which is the thing being read. It is drawn on the document's
 * own body, so nothing the app is made of can clip it or carry it away.
 */
export function ImageViewer({ src, name, onClose }: { src: string; name: string; onClose(): void }) {
  const closer = useRef<HTMLButtonElement>(null)
  /** Where the finger was before the picture came up: the way back is there. */
  const origin = useRef<HTMLElement | null>(null)
  /** The picture is on its way out: the animation plays, and only then it is taken off. */
  const [closing, setClosing] = useState(false)
  const close = useCallback((): void => setClosing(true), [])

  useEffect(() => {
    if (!origin.current) origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      close()
    }
    document.addEventListener('keydown', onKey)
    closer.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      if (origin.current?.isConnected) origin.current.focus()
    }
  }, [close])

  return createPortal(
    <div
      className={`image-viewer${closing ? ' closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      // The picture is only taken off the screen once it has finished leaving it.
      onAnimationEnd={(event) => { if (event.animationName === 'image-viewer-out') onClose() }}
    >
      {/* The way out by the back of the picture. Out of the accessibility tree,
          so it is not announced twice: the X is the control a person reaches for. */}
      <button className="image-viewer-scrim" type="button" aria-hidden="true" tabIndex={-1} onClick={close} />
      <img className="image-viewer-img" src={src} alt={name} />
      <button ref={closer} className="image-viewer-x" type="button" title="Close" aria-label="Close" onClick={close}>
        <Icon name="x" size={16} />
      </button>
    </div>,
    document.body,
  )
}
