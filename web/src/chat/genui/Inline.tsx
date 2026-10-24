import type { ReactNode } from 'react'
import { interpolate, type GenUiValues } from './evaluate.js'

/**
 * The strings inside a widget, with the three inline marks the teaching allows:
 * **bold**, *italic* and `code`. It is built as elements, never as HTML — the text
 * comes from a model, so the only thing a mark can become here is a React node.
 *
 * `{id}` is filled first, from the inputs' current values, exactly as a plain
 * paragraph does.
 */
export function Inline({ text, values }: { text: string; values: GenUiValues }): ReactNode {
  return split(interpolate(text, values))
}

const TOKEN = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g

function split(text: string): ReactNode[] {
  // A run's own words name it, with the count of how many times they have come
  // before — the same rule every list on this surface keys its rows by.
  const seen = new Map<string, number>()
  return text
    .split(TOKEN)
    .filter((piece) => piece !== '')
    .map((piece) => {
      const occurrence = seen.get(piece) ?? 0
      seen.set(piece, occurrence + 1)
      const key = `${piece}:${occurrence}`
      if (piece.startsWith('**') && piece.endsWith('**')) {
        return <strong key={key}>{piece.slice(2, -2)}</strong>
      }
      if (piece.startsWith('*') && piece.endsWith('*')) {
        return <em key={key}>{piece.slice(1, -1)}</em>
      }
      if (piece.startsWith('`') && piece.endsWith('`')) {
        return <code className="genui-inline-code" key={key}>{piece.slice(1, -1)}</code>
      }
      return <span key={key}>{piece}</span>
    })
}
