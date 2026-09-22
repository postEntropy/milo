import { theme, type ThemeColor } from './theme.js'
import { toolIcon } from '../tool-line.js'

export type LineColor = ThemeColor

/** A run of text with its own weight, for a line that has to mix them. */
export interface LineSegment {
  text: string
  bold?: boolean
}

export interface Line {
  text: string
  color?: LineColor
  dim?: boolean
  /**
   * Inline runs, when one line needs more than one weight — the tool name inside
   * its call, so the name reads as a name and not as the start of the arguments.
   * `text` stays the plain string the window and the tests work with.
   */
  segments?: LineSegment[]
}

export type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string; detail: string; ok: boolean }
  | { kind: 'error'; text: string }
  | { kind: 'info'; text: string }

export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  const out: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === '') line = word
      else if (line.length + 1 + word.length <= limit) line += ` ${word}`
      else {
        out.push(line)
        line = word
      }
    }
    while (line.length > limit) {
      out.push(line.slice(0, limit))
      line = line.slice(limit)
    }
    out.push(line)
  }

  return out.length > 0 ? out : ['']
}

export function buildLines(items: Item[], width: number): Line[] {
  const lines: Line[] = []
  const push = (text: string, style?: Partial<Line>) => lines.push({ text, ...style })

  items.forEach((item, index) => {
    if (index > 0) push('')
    switch (item.kind) {
      case 'user': {
        wrapText(item.text, width - 2).forEach((text, lineIndex) => {
          push(lineIndex === 0 ? `› ${text}` : `  ${text}`, {
            color: lineIndex === 0 ? theme.accent : undefined,
            dim: lineIndex > 0,
          })
        })
        break
      }
      case 'assistant':
        for (const text of wrapText(item.text, width)) push(text)
        break
      case 'tool': {
        // No parentheses when there is no detail to show (`/tools name`).
        const call = item.detail ? `${item.name}(${item.detail})` : item.name
        const head = item.ok ? toolIcon(item.name) : '✗'
        for (const text of wrapText(`${head} ${call}`, width)) {
          push(text, {
            color: item.ok ? theme.muted : theme.danger,
            segments: boldName(text, item.name),
          })
        }
        break
      }
      case 'error':
        for (const text of wrapText(`error: ${item.text}`, width)) push(text, { color: theme.danger })
        break
      case 'info':
        for (const text of wrapText(item.text, width)) push(text, { dim: true })
        break
    }
  })

  return lines
}

/**
 * The tool name in bold, so it reads as the name rather than as the start of the
 * arguments. Split from the wrapped line, so the name stays bold even when a
 * long call wraps.
 */
function boldName(text: string, name: string): LineSegment[] {
  const at = text.indexOf(name)
  if (at === -1) return [{ text }]
  return [
    { text: text.slice(0, at) },
    { text: name, bold: true },
    { text: text.slice(at + name.length) },
  ].filter((segment) => segment.text !== '')
}

export interface WindowResult {
  lines: Line[]
  offset: number
  maxOffset: number
}

/**
 * Returns the slice of lines that fits in `height`, anchored to the bottom.
 * `offset` counts lines scrolled up from the bottom (0 = newest at bottom).
 */
export function visibleWindow(lines: Line[], height: number, offset: number): WindowResult {
  const maxOffset = Math.max(0, lines.length - height)
  const clamped = Math.min(Math.max(0, offset), maxOffset)
  const start = Math.max(0, lines.length - height - clamped)
  return { lines: lines.slice(start, start + height), offset: clamped, maxOffset }
}

/**
 * Pads the top with blank lines so the content hugs the bottom of the pane —
 * messages grow upward, like a terminal or a chat app, instead of starting at
 * the top and filling down.
 */
export function padToBottom(lines: Line[], height: number): Line[] {
  const missing = height - lines.length
  if (missing <= 0) return lines
  return [...Array.from({ length: missing }, () => ({ text: '' }) as Line), ...lines]
}
