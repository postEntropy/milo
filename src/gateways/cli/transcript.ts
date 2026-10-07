import { theme, type ThemeColor } from './theme.js'
import { toolDisplayName, toolIcon } from '../tool-line.js'
import { todoMark, type TodoItem } from '../../core/todos.js'

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
   * A fill behind the line — the person's own message reads as one stripe, the
   * way the composer delimits itself by a surface rather than by a border.
   */
  background?: LineColor
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
  /**
   * The model's thinking, sitting under the question it belongs to: the line
   * saying how long it took, plus the reasoning itself when it is shown.
   * `header` is empty while the thought is still being written — there is nothing
   * to say about its length yet — and `text` is empty when only the line survives.
   */
  | { kind: 'reasoning'; header: string; text: string }
  /**
   * Labelled values, one per row. A block of them reads at a glance where the
   * same words run together as prose — `/stats` is the case that asked for it.
   */
  | { kind: 'fields'; rows: { label: string; value: string }[] }
  /**
   * The plan the model is keeping, drawn whole each time it changes. The current
   * step is the one thing in the accent colour — the eye's anchor in the block.
   */
  | { kind: 'todo'; items: TodoItem[] }

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
        // The person's words in a filled stripe, like the composer: what is theirs
        // is one band, and its own surface delimits it rather than a rule. The
        // prefix is part of the stripe, so the wrap leaves room for it — the fill
        // itself spans the column, so no padding is needed to reach the edge.
        for (const [lineIndex, text] of wrapText(item.text, width - 2).entries()) {
          const prefix = lineIndex === 0 ? '› ' : '  '
          push(`${prefix}${text}`, {
            color: theme.surfaceText,
            background: theme.surface,
          })
        }
        break
      }
      case 'assistant':
        lines.push(...markdownLines(item.text, width))
        break
      case 'tool': {
        // The same shape as the chat surfaces: icon, name, and the one value
        // worth showing — no JSON dump, and nothing when there is nothing
        // (`/tools name`).
        const name = toolDisplayName(item.name)
        const call = item.detail ? `${name} ${item.detail}` : name
        const head = item.ok ? toolIcon(item.name) : '✗'
        for (const text of wrapText(`${head} ${call}`, width)) {
          push(text, {
            color: item.ok ? theme.muted : theme.danger,
            segments: boldName(text, name),
          })
        }
        break
      }
      case 'error':
        for (const text of wrapText(`error: ${item.text}`, width)) push(text, { color: theme.danger })
        break
      case 'info':
        // Legible, not dim: this is what a command answered, and on a light
        // theme the faint variants of a palette are the first thing to vanish.
        for (const text of wrapText(item.text, width)) push(text, { color: theme.muted })
        break
      case 'reasoning': {
        for (const text of wrapText(item.header, width)) {
          if (item.header.trim()) push(text, { dim: true })
        }
        if (item.text.trim()) {
          // Indented, so the thinking reads as a note under the question rather
          // than as the start of the answer.
          for (const text of wrapText(item.text, width - 2)) {
            push(`  ${text}`, { color: theme.muted })
          }
        }
        break
      }
      case 'fields': {
        // The labels are one column, so the eye lands on the values; and a value
        // long enough to wrap hangs under itself rather than under the next
        // label, where it would read as that label's.
        const labelWidth = Math.max(0, ...item.rows.map((row) => row.label.length))
        const indent = ' '.repeat(labelWidth + 2)
        for (const row of item.rows) {
          const label = row.label.padEnd(labelWidth)
          wrapText(row.value, Math.max(8, width - labelWidth - 2)).forEach((text, lineIndex) => {
            if (lineIndex > 0) {
              lines.push({ text: `${indent}${text}`, color: theme.muted })
              return
            }
            lines.push({
              text: `${label}  ${text}`,
              segments: [{ text: label, color: theme.muted }, { text: `  ${text}` }],
            })
          })
        }
        break
      }
      case 'todo': {
        for (const todo of item.items) {
          const color =
            todo.status === 'completed' ? theme.success : todo.status === 'in_progress' ? theme.accent : theme.muted
          for (const text of wrapText(`${todoMark(todo.status)} ${todo.content}`, width)) push(text, { color })
        }
        break
      }
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
