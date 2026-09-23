import { theme, type ThemeColor } from './theme.js'
import { toolIcon } from '../tool-line.js'

export type LineColor = ThemeColor

/** A run of text with its own weight or colour, for a line that has to mix them. */
export interface LineSegment {
  text: string
  bold?: boolean
  color?: LineColor
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
    // Consecutive tool calls are one burst of work, not two paragraphs.
    const previous = items[index - 1]
    if (index > 0 && !(item.kind === 'tool' && previous?.kind === 'tool')) push('')
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
        lines.push(...markdownLines(item.text, width))
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

/**
 * Markdown as far as the terminal goes: fenced code blocks (markers gone, the
 * code kept as it was written), inline code, bold and headings. Tables and
 * nested lists are left as the plain text they are — the CLI is told to avoid
 * them, and half-rendering them reads worse than not trying.
 */
function markdownLines(text: string, width: number): Line[] {
  const lines: Line[] = []
  let inFence = false

  for (const source of text.split('\n')) {
    if (/^\s*```/.test(source)) {
      inFence = !inFence
      continue
    }

    if (inFence) {
      for (const piece of hardChunks(source, width)) {
        lines.push({ text: piece, color: theme.muted })
      }
      continue
    }

    if (source.trim() === '') {
      lines.push({ text: '' })
      continue
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(source)
    const segments = inlineSegments(heading ? heading[1]! : source)
    if (heading) for (const segment of segments) segment.bold = true

    for (const styled of wrapSegments(segments, width)) {
      const line = styled.map((segment) => segment.text).join('')
      const plain = styled.every((segment) => !segment.bold && !segment.color)
      lines.push(plain ? { text: line } : { text: line, segments: styled })
    }
  }

  return lines.length > 0 ? lines : [{ text: '' }]
}

/** `**bold**` and `` `code` `` — the two a terminal answer reaches for. */
function inlineSegments(text: string): LineSegment[] {
  const segments: LineSegment[] = []
  let last = 0

  for (const match of text.matchAll(/\*\*([^*]+)\*\*|`([^`]+)`/g)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    const bold = match[1]
    segments.push(
      bold !== undefined
        ? { text: bold, bold: true }
        : { text: match[2]!, color: theme.success },
    )
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })

  return segments
}

/** Wraps styled runs, so a span keeps its style — and its spacing — at a break. */
function wrapSegments(segments: LineSegment[], width: number): LineSegment[][] {
  const limit = Math.max(1, width)
  const plain = segments.map((segment) => segment.text).join('')
  // Which run each character came from, so a word is styled by its first one.
  const styleOf: LineSegment[] = []
  for (const segment of segments) {
    for (let index = 0; index < segment.text.length; index += 1) styleOf.push(segment)
  }

  const lines: LineSegment[][] = []
  let line: LineSegment[] = []
  let length = 0

  const add = (text: string, style: LineSegment) => {
    const last = line[line.length - 1]
    if (last && last.bold === style.bold && last.color === style.color) last.text += text
    else line.push({ text, bold: style.bold, color: style.color })
    length += text.length
  }

  const wrap = () => {
    if (line.length > 0) lines.push(line)
    line = []
    length = 0
  }

  for (const match of plain.matchAll(/\S+/g)) {
    const word = match[0]
    const at = match.index
    const style = styleOf[at]
    // Whether a space stood before this word. Punctuation that follows a span —
    // `**cuidado**.` — had none, and must not gain one.
    const spaced = at > 0 && /\s/.test(plain[at - 1])

    if (word.length > limit) {
      // Longer than a whole line — a URL, a hash — cut instead of overflowed.
      for (let sliceAt = 0; sliceAt < word.length; sliceAt += limit) {
        if (sliceAt > 0) wrap()
        add(word.slice(sliceAt, sliceAt + limit), style)
      }
      continue
    }

    // The space is what a wrap drops, so it belongs to the word after it.
    if (line.length > 0 && length + (spaced ? 1 : 0) + word.length > limit) wrap()
    add(line.length === 0 || !spaced ? word : ` ${word}`, style)
  }
  wrap()

  return lines.length > 0 ? lines : [[]]
}

/** Cuts a line of code at the width, keeping its indentation and characters. */
function hardChunks(text: string, width: number): string[] {
  if (text === '') return ['']
  return text.match(new RegExp(`.{1,${Math.max(1, width)}}`, 'gu')) ?? ['']
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
