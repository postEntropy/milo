import type { FileChange } from '../../core/change.js'
import { todoMark, type TodoItem } from '../../core/todos.js'
import { changeCounts, toolDisplayName, toolIcon, toolInput } from '../tool-line.js'
import { theme, type ThemeColor, type TuiTheme } from './theme.js'

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
  | {
      kind: 'tool'
      name: string
      detail: string
      ok: boolean
      counts?: string
      args?: unknown
      result?: string
      change?: FileChange[]
      expanded?: boolean
    }
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
  /**
   * What the project's own checks answered after a turn that wrote. `text` is
   * the core's wording, the same block every surface draws.
   */
  | { kind: 'verification'; ok: boolean; text: string }
  /** A generated UI summary card in the terminal transcript. */
  | { kind: 'ui'; title?: string; summary: string }
  /** A muted notice describing a panel action. */
  | { kind: 'panel'; detail: string }
  /** A mid-turn steering note handed to the running turn. */
  | { kind: 'steer'; text: string }

const MAX_EXPANDED_ARGS_LINES = 12
const MAX_EXPANDED_RESULT_LINES = 16
const MAX_EXPANDED_DIFF_LINES = 30

interface CachedItem {
  width: number
  themeKey: string
  expanded: boolean
  lines: Line[]
}

const itemCache = new WeakMap<Item, CachedItem>()

function themeSignature(activeTheme: TuiTheme): string {
  return [
    activeTheme.accent,
    activeTheme.secondary,
    activeTheme.success,
    activeTheme.warning,
    activeTheme.danger,
    activeTheme.muted,
    activeTheme.surface,
    activeTheme.surfaceText,
  ].join('|')
}

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

export function buildLines(items: Item[], width: number, activeTheme: TuiTheme = theme): Line[] {
  const lines: Line[] = []
  const key = themeSignature(activeTheme)

  items.forEach((item, index) => {
    // Consecutive tool calls are one burst of work, not two paragraphs.
    const previous = items[index - 1]
    if (index > 0 && !(item.kind === 'tool' && previous?.kind === 'tool')) {
      lines.push({ text: '' })
    }

    const expanded = item.kind === 'tool' ? Boolean(item.expanded) : false
    const cached = itemCache.get(item)
    if (cached && cached.width === width && cached.themeKey === key && cached.expanded === expanded) {
      lines.push(...cached.lines)
      return
    }

    const rendered = renderItem(item, width, activeTheme)
    itemCache.set(item, { width, themeKey: key, expanded, lines: rendered })
    lines.push(...rendered)
  })

  return lines
}

function renderItem(item: Item, width: number, activeTheme: TuiTheme): Line[] {
  const lines: Line[] = []
  const push = (text: string, style?: Partial<Line>) => lines.push({ text, ...style })

  switch (item.kind) {
    case 'user': {
      // The person's words in a filled stripe, like the composer: what is theirs
      // is one band, and its own surface delimits it rather than a rule. The
      // prefix is part of the stripe, so the wrap leaves room for it — the fill
      // itself spans the column, so no padding is needed to reach the edge.
      for (const [lineIndex, text] of wrapText(item.text, width - 2).entries()) {
        const prefix = lineIndex === 0 ? '› ' : '  '
        push(`${prefix}${text}`, {
          color: activeTheme.surfaceText,
          background: activeTheme.surface,
        })
      }
      break
    }
    case 'assistant':
      lines.push(...markdownLines(item.text, width, activeTheme))
      break
    case 'tool': {
      // The same shape as the chat surfaces: icon, name, and the one value
      // worth showing — no JSON dump, and nothing when there is nothing
      // (`/tools name`).
      const name = toolDisplayName(item.name)
      // How much the call moved, in the same two tones the chat and browser count a
      // write with. The terminal has no colour pair per segment, so the numbers ride
      // the muted line they belong to.
      const call = [item.detail ? `${name} ${item.detail}` : name, item.counts]
        .filter(Boolean)
        .join(' ')
      const head = item.ok ? toolIcon(item.name) : '✗'
      for (const text of wrapText(`${head} ${call}`, width)) {
        push(text, {
          color: item.ok ? activeTheme.muted : activeTheme.danger,
          segments: boldName(text, name),
        })
      }
      if (item.expanded) {
        lines.push(...expandedToolLines(item, width, activeTheme))
      }
      break
    }
    case 'error':
      for (const text of wrapText(`error: ${item.text}`, width)) push(text, { color: activeTheme.danger })
      break
    case 'info':
      // Legible, not dim: this is what a command answered, and on a light
      // theme the faint variants of a palette are the first thing to vanish.
      for (const text of wrapText(item.text, width)) push(text, { color: activeTheme.muted })
      break
    case 'reasoning': {
      for (const text of wrapText(item.header, width)) {
        if (item.header.trim()) push(text, { dim: true })
      }
      if (item.text.trim()) {
        // Indented, so the thinking reads as a note under the question rather
        // than as the start of the answer.
        for (const text of wrapText(item.text, width - 2)) {
          push(`  ${text}`, { color: activeTheme.muted })
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
            lines.push({ text: `${indent}${text}`, color: activeTheme.muted })
            return
          }
          lines.push({
            text: `${label}  ${text}`,
            segments: [{ text: label, color: activeTheme.muted }, { text: `  ${text}` }],
          })
        })
      }
      break
    }
    case 'todo': {
      for (const todo of item.items) {
        const color =
          todo.status === 'completed'
            ? activeTheme.success
            : todo.status === 'in_progress'
              ? activeTheme.accent
              : activeTheme.muted
        for (const text of wrapText(`${todoMark(todo.status)} ${todo.content}`, width)) push(text, { color })
      }
      break
    }
    case 'verification': {
      // The first line is the verdict and wears the colour; the detail under it
      // is the failing command's own output, muted so it does not read as a
      // second verdict.
      for (const [index, line] of item.text.split('\n').entries()) {
        for (const text of wrapText(line, width)) {
          push(text, { color: index === 0 ? (item.ok ? activeTheme.success : activeTheme.danger) : activeTheme.muted })
        }
      }
      break
    }
    case 'ui': {
      const title = item.title?.trim()
      if (title) {
        for (const text of wrapText(`◆ ${title}`, width)) {
          push(text, {
            color: activeTheme.secondary,
            segments: [{ text, bold: true, color: activeTheme.secondary }],
          })
        }
        if (item.summary.trim()) {
          for (const text of wrapText(item.summary, Math.max(1, width - 2))) {
            push(`  ${text}`, { color: activeTheme.muted })
          }
        }
      } else {
        for (const text of wrapText(`◆ ${item.summary}`, width)) {
          push(text, { color: activeTheme.muted })
        }
      }
      break
    }
    case 'panel':
      for (const text of wrapText(item.detail, width)) push(text, { color: activeTheme.muted })
      break
    case 'steer': {
      const prefix = '↳ steered: '
      const innerWidth = Math.max(1, width - prefix.length)
      const hang = ' '.repeat(prefix.length)
      wrapText(item.text, innerWidth).forEach((text, lineIndex) => {
        if (lineIndex === 0) {
          push(`${prefix}${text}`, {
            color: activeTheme.muted,
            segments: [
              { text: prefix, color: activeTheme.secondary },
              { text, color: activeTheme.muted },
            ],
          })
        } else {
          push(`${hang}${text}`, { color: activeTheme.muted })
        }
      })
      break
    }
  }

  return lines
}

function expandedToolLines(item: Extract<Item, { kind: 'tool' }>, width: number, activeTheme: TuiTheme): Line[] {
  const lines: Line[] = []
  const innerWidth = Math.max(1, width - 2)

  if (item.args !== undefined) {
    const formatted = toolInput(item.name, item.args)
    if (formatted.trim()) {
      const rawLines = formatted.split('\n')
      let count = 0
      let truncated = false
      for (const raw of rawLines) {
        for (const piece of hardChunks(raw, innerWidth)) {
          if (count >= MAX_EXPANDED_ARGS_LINES) {
            truncated = true
            break
          }
          lines.push({ text: `  ${piece}`, color: activeTheme.muted })
          count += 1
        }
        if (truncated) break
      }
      if (truncated) {
        lines.push({ text: '  … (args truncated)', color: activeTheme.muted, dim: true })
      }
    }
  }

  if (item.change?.length) {
    let diffCount = 0
    let diffTruncated = false
    for (const file of item.change) {
      if (diffCount >= MAX_EXPANDED_DIFF_LINES) {
        diffTruncated = true
        break
      }
      const counts = changeCounts([file])
      const header = counts ? `${file.path} (${counts})` : file.path
      for (const piece of wrapText(header, innerWidth)) {
        lines.push({ text: `  ${piece}`, color: activeTheme.secondary })
      }
      const contentWidth = Math.max(1, width - 4)
      for (const entry of file.lines) {
        if (diffCount >= MAX_EXPANDED_DIFF_LINES) {
          diffTruncated = true
          break
        }
        diffCount += 1
        const sign = entry.kind === 'add' ? '+ ' : entry.kind === 'remove' ? '- ' : '  '
        const color =
          entry.kind === 'add'
            ? activeTheme.success
            : entry.kind === 'remove'
              ? activeTheme.danger
              : activeTheme.muted
        for (const [pieceIndex, piece] of hardChunks(entry.text, contentWidth).entries()) {
          const prefix = pieceIndex === 0 ? `  ${sign}` : '    '
          lines.push({ text: `${prefix}${piece}`, color })
        }
      }
      if (file.truncated && !diffTruncated) {
        lines.push({ text: '  … (diff truncated)', color: activeTheme.muted, dim: true })
      }
    }
    if (diffTruncated) {
      lines.push({ text: '  … (diff truncated)', color: activeTheme.muted, dim: true })
    }
  }

  if (item.result?.trim()) {
    const rawLines = item.result.replace(/\s+$/, '').split('\n')
    let count = 0
    let truncated = false
    for (const raw of rawLines) {
      for (const piece of wrapText(raw, innerWidth)) {
        if (count >= MAX_EXPANDED_RESULT_LINES) {
          truncated = true
          break
        }
        lines.push({ text: `  ${piece}`, color: activeTheme.muted })
        count += 1
      }
      if (truncated) break
    }
    if (truncated) {
      lines.push({ text: '  … (result truncated)', color: activeTheme.muted, dim: true })
    }
  }

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
 * Markdown as far as the terminal goes: fenced code blocks (optional language
 * label, code kept as it was written), inline code, bold, headings, unordered
 * and ordered lists with hanging indents, and blockquotes.
 */
function markdownLines(text: string, width: number, activeTheme: TuiTheme): Line[] {
  const lines: Line[] = []
  let inFence = false

  for (const source of text.split('\n')) {
    if (!inFence) {
      const open = /^\s*```(.*)$/.exec(source)
      if (open) {
        inFence = true
        const lang = open[1]!.trim()
        if (lang) {
          lines.push({ text: lang, color: activeTheme.muted, dim: true })
        }
        continue
      }
    } else if (/^\s*```\s*$/.test(source)) {
      inFence = false
      continue
    }

    if (inFence) {
      for (const piece of hardChunks(source, width)) {
        lines.push({ text: piece, color: activeTheme.muted })
      }
      continue
    }

    if (source.trim() === '') {
      lines.push({ text: '' })
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(source)
    if (quote) {
      renderQuoteLine(quote[1]!, width, activeTheme, lines)
      continue
    }

    const unordered = /^(\s*)[-*]\s+(.*)$/.exec(source)
    if (unordered) {
      renderListLine(`${unordered[1]!}• `, unordered[2]!, width, activeTheme, lines)
      continue
    }

    const ordered = /^(\s*)(\d+\.)\s+(.*)$/.exec(source)
    if (ordered) {
      renderListLine(`${ordered[1]!}${ordered[2]!} `, ordered[3]!, width, activeTheme, lines)
      continue
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(source)
    const segments = inlineSegments(heading ? heading[1]! : source, activeTheme)
    if (heading) for (const segment of segments) segment.bold = true

    for (const styled of wrapSegments(segments, width)) {
      const line = styled.map((segment) => segment.text).join('')
      const plain = styled.every((segment) => !segment.bold && !segment.color)
      lines.push(plain ? { text: line } : { text: line, segments: styled })
    }
  }

  return lines.length > 0 ? lines : [{ text: '' }]
}

function renderQuoteLine(body: string, width: number, activeTheme: TuiTheme, lines: Line[]): void {
  const marker = '▎ '
  if (body.trim() === '') {
    lines.push({ text: '▎', color: activeTheme.secondary })
    return
  }
  const innerWidth = Math.max(1, width - marker.length)
  const segments = inlineSegments(body, activeTheme)
  for (const styled of wrapSegments(segments, innerWidth)) {
    const bodyText = styled.map((segment) => segment.text).join('')
    const bodySegments = styled.map((segment) => (segment.color ? segment : { ...segment, color: activeTheme.muted }))
    lines.push({
      text: `${marker}${bodyText}`,
      segments: [{ text: marker, color: activeTheme.secondary }, ...bodySegments],
    })
  }
}

function renderListLine(marker: string, body: string, width: number, activeTheme: TuiTheme, lines: Line[]): void {
  const hang = ' '.repeat(marker.length)
  const innerWidth = Math.max(1, width - marker.length)
  const segments = inlineSegments(body, activeTheme)
  wrapSegments(segments, innerWidth).forEach((styled, lineIndex) => {
    const text = styled.map((segment) => segment.text).join('')
    if (lineIndex === 0) {
      lines.push({
        text: `${marker}${text}`,
        segments: [{ text: marker, color: activeTheme.muted }, ...styled],
      })
      return
    }
    const plain = styled.every((segment) => !segment.bold && !segment.color)
    lines.push(plain ? { text: `${hang}${text}` } : { text: `${hang}${text}`, segments: [{ text: hang }, ...styled] })
  })
}

/** `**bold**` and `` `code` `` — the two a terminal answer reaches for. */
function inlineSegments(text: string, activeTheme: TuiTheme): LineSegment[] {
  const segments: LineSegment[] = []
  let last = 0

  for (const match of text.matchAll(/\*\*([^*]+)\*\*|`([^`]+)`/g)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    const bold = match[1]
    segments.push(
      bold !== undefined
        ? { text: bold, bold: true }
        : { text: match[2]!, color: activeTheme.success },
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
