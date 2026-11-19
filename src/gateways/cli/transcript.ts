import type { FileChange } from '../../core/change.js'
import { formatBotAvatarBadge, resolveBotAvatar } from '../../core/crew.js'
import { highlight, languageOf, type CodeRole, type CodeRun } from '../../core/highlight.js'
import type { BotAuthor } from '../../core/providers/types.js'
import { todoMark, type TodoItem } from '../../core/todos.js'
import { changeCounts, toolDisplayName, toolIcon, toolInput } from '../tool-line.js'
import { theme, type ThemeColor, type TuiTheme } from './theme.js'

export type LineColor = ThemeColor

/** A run of text with its own weight or colour, for a line that has to mix them. */
export interface LineSegment {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
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
  | { kind: 'bot'; bot: BotAuthor }
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

interface CachedRender {
  width: number
  themeKey: string
  expanded: boolean
  lines: Line[]
}

const MAX_ITEM_CACHE_WIDTHS = 2
const itemCache = new WeakMap<Item, CachedRender[]>()

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
    activeTheme.logoTop,
    activeTheme.logoBottom,
  ].join('|')
}

function codePointWidth(cp: number): number {
  if (
    cp === 0 ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 0
  }
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faf8) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2
  }
  return 1
}

function visualWidth(text: string): number {
  let width = 0
  for (const ch of text) width += codePointWidth(ch.codePointAt(0) ?? 0)
  return width
}

function splitByVisualWidth(text: string, limit: number): { head: string; rest: string } {
  let width = 0
  let splitAt = 0
  const chars = [...text]
  for (let i = 0; i < chars.length; i++) {
    const w = codePointWidth(chars[i]!.codePointAt(0) ?? 0)
    if (width + w > limit && splitAt > 0) break
    width += w
    splitAt = i + 1
  }
  if (splitAt === 0 && chars.length > 0) splitAt = 1
  return { head: chars.slice(0, splitAt).join(''), rest: chars.slice(splitAt).join('') }
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
    let lineWidth = 0
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const wordWidth = visualWidth(word)
      if (line === '') {
        line = word
        lineWidth = wordWidth
      } else if (lineWidth + 1 + wordWidth <= limit) {
        line += ` ${word}`
        lineWidth += 1 + wordWidth
      } else {
        out.push(line)
        line = word
        lineWidth = wordWidth
      }
    }
    while (visualWidth(line) > limit) {
      const { head, rest } = splitByVisualWidth(line, limit)
      out.push(head)
      line = rest
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
    if (
      index > 0 &&
      !(item.kind === 'tool' && previous?.kind === 'tool') &&
      previous?.kind !== 'bot'
    ) {
      lines.push({ text: '' })
    }

    const expanded = item.kind === 'tool' ? Boolean(item.expanded) : false
    const entries = itemCache.get(item)
    const cached = entries?.find(
      (entry) => entry.width === width && entry.themeKey === key && entry.expanded === expanded,
    )
    if (cached) {
      lines.push(...cached.lines)
      return
    }

    const rendered = renderItem(item, width, activeTheme)
    const compatible =
      entries?.filter((entry) => entry.themeKey === key && entry.expanded === expanded) ?? []
    itemCache.set(
      item,
      [{ width, themeKey: key, expanded, lines: rendered }, ...compatible].slice(
        0,
        MAX_ITEM_CACHE_WIDTHS,
      ),
    )
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
    case 'bot': {
      const badge = formatBotAvatarBadge(resolveBotAvatar(item.bot))
      const label = item.bot.handle
        ? `${badge} ${item.bot.name} (@${item.bot.handle})`
        : `${badge} ${item.bot.name}`
      for (const text of wrapText(label, width)) {
        push(text, {
          color: activeTheme.accent,
          segments: [{ text, bold: true, color: activeTheme.accent }],
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
      // (`/tools name`). A `shell_command` with a command drops the label.
      const name = toolDisplayName(item.name)
      const hasLabel = !(item.name === 'shell_command' && item.detail)
      const baseCall = hasLabel ? (item.detail ? `${name} ${item.detail}` : name) : item.detail
      const label = hasLabel ? name : ''
      const head = item.ok ? toolIcon(item.name) : '✗'
      const countsText = item.counts?.trim() ?? ''
      const lineColor = item.ok ? activeTheme.muted : activeTheme.danger

      if (!countsText) {
        for (const text of wrapText(`${head} ${baseCall}`, width)) {
          push(text, {
            color: lineColor,
            ...(label ? { segments: boldName(text, label) } : {}),
          })
        }
      } else {
        const full = `${head} ${baseCall} ${countsText}`
        const normalized = full.replace(/\s+/g, ' ').trim()
        const countsStart = normalized.length - countsText.length
        let cursor = 0
        for (const text of wrapText(full, width)) {
          const lineStart = cursor
          push(text, {
            color: lineColor,
            segments: toolLineSegments(text, label, countsStart - lineStart, activeTheme),
          })
          cursor += text.length
          if (normalized[cursor] === ' ') cursor += 1
        }
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
      if (item.header.trim()) {
        for (const [lineIndex, text] of wrapText(item.header, width).entries()) {
          if (lineIndex === 0 && text.startsWith('✻')) {
            const rest = text.slice(1)
            const segments: LineSegment[] = [{ text: '✻', color: activeTheme.secondary }]
            if (rest) segments.push({ text: rest, color: activeTheme.muted, italic: true })
            push(text, { color: activeTheme.muted, segments })
          } else {
            push(text, {
              color: activeTheme.muted,
              segments: [{ text, color: activeTheme.muted, italic: true }],
            })
          }
        }
      }
      if (item.text.trim()) {
        const innerWidth = Math.max(1, width - 2)
        // Indented with a rail, so the thinking reads as a note under the question
        // rather than as the start of the answer.
        for (const text of wrapText(item.text, innerWidth)) {
          push(`▎ ${text}`, {
            color: activeTheme.muted,
            segments: [
              { text: '▎ ', color: activeTheme.secondary },
              { text, color: activeTheme.muted },
            ],
          })
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
      const innerWidth = Math.max(1, width - 2)
      for (const todo of item.items) {
        const color =
          todo.status === 'completed'
            ? activeTheme.success
            : todo.status === 'in_progress'
              ? activeTheme.accent
              : activeTheme.muted
        const isActive = todo.status === 'in_progress'
        const railColor = isActive ? activeTheme.accent : activeTheme.muted
        for (const text of wrapText(`${todoMark(todo.status)} ${todo.content}`, innerWidth)) {
          const bodySegment: LineSegment = isActive ? { text, color, bold: true } : { text, color }
          push(`▎ ${text}`, {
            color,
            segments: [{ text: '▎ ', color: railColor }, bodySegment],
          })
        }
      }
      break
    }
    case 'verification': {
      // The first line is the verdict and wears the colour; the detail under it
      // is the failing command's own output, muted so it does not read as a
      // second verdict.
      const verdictColor = item.ok ? activeTheme.success : activeTheme.danger
      const innerWidth = Math.max(1, width - 2)
      for (const [index, line] of item.text.split('\n').entries()) {
        const bodyColor = index === 0 ? verdictColor : activeTheme.muted
        for (const text of wrapText(line, innerWidth)) {
          const bodySegment: LineSegment =
            index === 0 ? { text, color: bodyColor, bold: true } : { text, color: bodyColor }
          push(`▎ ${text}`, {
            color: bodyColor,
            segments: [{ text: '▎ ', color: verdictColor }, bodySegment],
          })
        }
      }
      break
    }
    case 'ui': {
      const title = item.title?.trim()
      const innerWidth = Math.max(1, width - 2)
      if (title) {
        for (const text of wrapText(`◆ ${title}`, innerWidth)) {
          push(`▎ ${text}`, {
            color: activeTheme.secondary,
            segments: [
              { text: '▎ ', color: activeTheme.secondary },
              { text, bold: true, color: activeTheme.secondary },
            ],
          })
        }
        if (item.summary.trim()) {
          for (const text of wrapText(item.summary, innerWidth)) {
            push(`▎ ${text}`, {
              color: activeTheme.muted,
              segments: [
                { text: '▎ ', color: activeTheme.secondary },
                { text, color: activeTheme.muted },
              ],
            })
          }
        }
      } else {
        for (const text of wrapText(`◆ ${item.summary}`, innerWidth)) {
          push(`▎ ${text}`, {
            color: activeTheme.muted,
            segments: [
              { text: '▎ ', color: activeTheme.secondary },
              { text, color: activeTheme.muted },
            ],
          })
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
  const pushNotice = (notice: string) => {
    lines.push({
      text: `▎ ${notice}`,
      color: activeTheme.muted,
      segments: [
        { text: '▎ ', color: activeTheme.muted },
        { text: notice, color: activeTheme.muted, italic: true },
      ],
    })
  }

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
          lines.push({ text: `▎ ${piece}`, color: activeTheme.muted })
          count += 1
        }
        if (truncated) break
      }
      if (truncated) pushNotice('… (args truncated)')
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
        lines.push({
          text: `▎ ${piece}`,
          color: activeTheme.secondary,
          segments: [
            { text: '▎ ', color: activeTheme.secondary },
            { text: piece, color: activeTheme.secondary, bold: true },
          ],
        })
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
          const prefix = pieceIndex === 0 ? sign : '  '
          lines.push({
            text: `▎ ${prefix}${piece}`,
            color,
            segments: [
              { text: '▎ ', color: activeTheme.muted },
              { text: `${prefix}${piece}`, color },
            ],
          })
        }
      }
      if (file.truncated && !diffTruncated) pushNotice('… (diff truncated)')
    }
    if (diffTruncated) pushNotice('… (diff truncated)')
  }

  if (item.result?.trim()) {
    const formatted = formatResultForDisplay(item.result)
    const rawLines = formatted.replace(/\s+$/, '').split('\n')
    let count = 0
    let truncated = false
    for (const raw of rawLines) {
      for (const piece of wrapText(raw, innerWidth)) {
        if (count >= MAX_EXPANDED_RESULT_LINES) {
          truncated = true
          break
        }
        lines.push({ text: `▎ ${piece}`, color: activeTheme.muted })
        count += 1
      }
      if (truncated) break
    }
    if (truncated) pushNotice('… (result truncated)')
  }

  return lines
}

function formatResultForDisplay(raw: string): string {
  const trimmed = raw.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return raw
    }
  }
  return raw
}

/**
 * The tool name in bold, so it reads as the name rather than as the start of the
 * arguments. Split from the wrapped line, so the name stays bold even when a
 * long call wraps.
 */
function boldName(text: string, name: string): LineSegment[] {
  if (!name) return [{ text }]
  const at = text.indexOf(name)
  if (at === -1) return [{ text }]
  return [
    { text: text.slice(0, at) },
    { text: name, bold: true },
    { text: text.slice(at + name.length) },
  ].filter((segment) => segment.text !== '')
}

/** Splits a tool line into bold tool name and colored `+N` / `−M` diff counts. */
function toolLineSegments(
  text: string,
  name: string,
  countsOffset: number,
  activeTheme: TuiTheme,
): LineSegment[] {
  const splitAt = Math.max(0, Math.min(text.length, countsOffset))
  const headPart = text.slice(0, splitAt)
  const countsPart = text.slice(splitAt)
  const segments: LineSegment[] = headPart ? boldName(headPart, name) : []

  if (countsPart) {
    let last = 0
    for (const match of countsPart.matchAll(/(\+\d+|[-−]\d+)/g)) {
      if (match.index > last) {
        segments.push({ text: countsPart.slice(last, match.index) })
      }
      const token = match[0]
      segments.push({
        text: token,
        color: token.startsWith('+') ? activeTheme.success : activeTheme.danger,
      })
      last = match.index + token.length
    }
    if (last < countsPart.length) {
      segments.push({ text: countsPart.slice(last) })
    }
  }

  return segments.length > 0 ? segments : [{ text }]
}

function isPlainSegment(segment: LineSegment): boolean {
  return !segment.bold && !segment.italic && !segment.underline && !segment.color
}

/**
 * Markdown as far as the terminal goes: syntax-highlighted fenced code blocks,
 * pipe tables, inline code, bold, italic, links, headings, unordered and
 * ordered lists with hanging indents, and blockquotes.
 */
function markdownLines(text: string, width: number, activeTheme: TuiTheme): Line[] {
  const lines: Line[] = []
  const sourceLines = text.split('\n')

  for (let index = 0; index < sourceLines.length; index += 1) {
    const source = sourceLines[index]!
    const open = /^\s*```(.*)$/.exec(source)
    if (open) {
      const lang = open[1]!.trim()
      const codeLines: string[] = []
      while (index + 1 < sourceLines.length) {
        const next = sourceLines[index + 1]!
        index += 1
        if (/^\s*```\s*$/.test(next)) break
        codeLines.push(next)
      }
      renderCodeBlock(codeLines, lang, width, activeTheme, lines)
      continue
    }

    if (source.trim() === '') {
      lines.push({ text: '' })
      continue
    }

    if (index + 1 < sourceLines.length) {
      const headerCells = parseTableRow(source)
      const nextLine = sourceLines[index + 1]!
      if (
        headerCells &&
        (source.trim().startsWith('|') || headerCells.length >= 2) &&
        isTableSeparatorRow(nextLine, headerCells.length)
      ) {
        index += 1
        const bodyRows: string[][] = []
        while (index + 1 < sourceLines.length) {
          const candidate = sourceLines[index + 1]!
          if (candidate.trim() === '' || /^\s*```/.test(candidate) || isTableSeparatorRow(candidate)) break
          const rowCells = parseTableRow(candidate)
          if (!rowCells) break
          bodyRows.push(rowCells)
          index += 1
        }
        renderTable(headerCells, bodyRows, width, activeTheme, lines)
        continue
      }
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

    const heading = /^(#{1,6})\s+(.*)$/.exec(source)
    if (heading) {
      const level = heading[1]!.length
      const headingColor = level === 1 ? activeTheme.accent : level === 2 ? activeTheme.secondary : undefined
      const segments = inlineSegments(heading[2]!, activeTheme).map((segment) => ({
        ...segment,
        bold: true,
        ...(headingColor && !segment.color ? { color: headingColor } : {}),
      }))
      for (const styled of wrapSegments(segments, width)) {
        const line = styled.map((segment) => segment.text).join('')
        lines.push({ text: line, segments: styled })
      }
      continue
    }

    const segments = inlineSegments(source, activeTheme)
    for (const styled of wrapSegments(segments, width)) {
      const line = styled.map((segment) => segment.text).join('')
      const plain = styled.every(isPlainSegment)
      lines.push(plain ? { text: line } : { text: line, segments: styled })
    }
  }

  return lines.length > 0 ? lines : [{ text: '' }]
}

function roleSegment(role: CodeRole, text: string, activeTheme: TuiTheme): LineSegment {
  switch (role) {
    case 'keyword':
      return { text, color: activeTheme.accent, bold: true }
    case 'string':
      return { text, color: activeTheme.success }
    case 'number':
      return { text, color: activeTheme.secondary }
    case 'comment':
      return { text, color: activeTheme.muted, italic: true }
    case 'plain':
      return { text }
  }
}

function splitRunsByNewline(runs: CodeRun[]): CodeRun[][] {
  const lines: CodeRun[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) lines.push([])
      const part = parts[i]!
      if (part !== '') lines[lines.length - 1]!.push({ role: run.role, text: part })
    }
  }
  return lines
}

function renderCodeBlock(
  codeLines: string[],
  lang: string,
  width: number,
  activeTheme: TuiTheme,
  lines: Line[],
): void {
  if (lang) {
    lines.push({
      text: `▎ ${lang}`,
      segments: [
        { text: '▎ ', color: activeTheme.secondary },
        { text: lang, color: activeTheme.muted, bold: true },
      ],
    })
  }

  if (codeLines.length === 0) return

  const resolvedLang = lang ? languageOf(lang) : undefined
  const highlighted = splitRunsByNewline(highlight(codeLines.join('\n'), resolvedLang))
  const innerWidth = Math.max(1, width - 2)

  for (const lineRuns of highlighted) {
    if (lineRuns.length === 0) {
      lines.push({ text: '▎', segments: [{ text: '▎', color: activeTheme.secondary }] })
      continue
    }

    const styledChars: Array<{ ch: string; role: CodeRole }> = []
    for (const run of lineRuns) {
      for (const ch of Array.from(run.text)) {
        styledChars.push({ ch, role: run.role })
      }
    }

    for (let offset = 0; offset < styledChars.length; offset += innerWidth) {
      const slice = styledChars.slice(offset, offset + innerWidth)
      const bodySegments: LineSegment[] = []
      let currentRole: CodeRole | null = null
      let buffer = ''

      for (const item of slice) {
        if (currentRole === item.role) {
          buffer += item.ch
        } else {
          if (currentRole !== null && buffer !== '') {
            bodySegments.push(roleSegment(currentRole, buffer, activeTheme))
          }
          currentRole = item.role
          buffer = item.ch
        }
      }
      if (currentRole !== null && buffer !== '') {
        bodySegments.push(roleSegment(currentRole, buffer, activeTheme))
      }

      const bodyText = bodySegments.map((segment) => segment.text).join('')
      lines.push({
        text: `▎ ${bodyText}`,
        segments: [{ text: '▎ ', color: activeTheme.secondary }, ...bodySegments],
      })
    }
  }
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  const cells = stripped.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
  return cells.length > 0 ? cells : null
}

function isTableSeparatorRow(line: string, expectedCols?: number): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  const cells = parseTableRow(line)
  if (!cells) return false
  if (!trimmed.startsWith('|') && cells.length < 2) return false
  if (expectedCols !== undefined && cells.length !== expectedCols) return false
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell))
}

function truncateSegments(segments: LineSegment[], maxWidth: number): LineSegment[] {
  const total = segments.reduce((sum, segment) => sum + Array.from(segment.text).length, 0)
  if (total <= maxWidth) return segments
  if (maxWidth <= 1) {
    const first = segments[0]
    return first ? [{ ...first, text: '…'.slice(0, maxWidth) }] : []
  }
  let remaining = maxWidth - 1
  const out: LineSegment[] = []
  for (const segment of segments) {
    if (remaining <= 0) break
    const chars = Array.from(segment.text)
    if (chars.length <= remaining) {
      out.push({ ...segment })
      remaining -= chars.length
    } else {
      out.push({ ...segment, text: `${chars.slice(0, remaining).join('')}…` })
      remaining = 0
    }
  }
  return out
}

function renderTable(
  headerCells: string[],
  bodyRows: string[][],
  width: number,
  activeTheme: TuiTheme,
  lines: Line[],
): void {
  const colCount = Math.max(headerCells.length, ...bodyRows.map((row) => row.length))
  const parseRow = (row: string[], isHeader: boolean) =>
    Array.from({ length: colCount }, (_, colIndex) => {
      const raw = row[colIndex] ?? ''
      const segments = inlineSegments(raw, activeTheme).map((segment) =>
        isHeader
          ? {
              ...segment,
              bold: true,
              color: segment.color ?? activeTheme.accent,
            }
          : segment,
      )
      const plainLength = segments.reduce((sum, segment) => sum + Array.from(segment.text).length, 0)
      return { segments, plainLength }
    })

  const parsedHeader = parseRow(headerCells, true)
  const parsedBody = bodyRows.map((row) => parseRow(row, false))
  const allRows = [parsedHeader, ...parsedBody]

  const colWidths = Array.from({ length: colCount }, (_, colIndex) =>
    Math.max(1, ...allRows.map((row) => row[colIndex]!.plainLength)),
  )

  const gap = '  '
  const available = Math.max(colCount, width - gap.length * (colCount - 1))
  let totalWidth = colWidths.reduce((sum, w) => sum + w, 0)
  while (totalWidth > available) {
    let widestIndex = 0
    for (let i = 1; i < colWidths.length; i += 1) {
      if (colWidths[i]! > colWidths[widestIndex]!) widestIndex = i
    }
    if (colWidths[widestIndex]! <= 1) break
    colWidths[widestIndex]! -= 1
    totalWidth -= 1
  }

  for (const row of allRows) {
    const rowSegments: LineSegment[] = []
    for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
      if (colIndex > 0) rowSegments.push({ text: gap })
      const cell = row[colIndex]!
      const colWidth = colWidths[colIndex]!
      const clipped = truncateSegments(cell.segments, colWidth)
      const clippedLen = clipped.reduce((sum, segment) => sum + Array.from(segment.text).length, 0)
      rowSegments.push(...clipped)
      const pad = colWidth - clippedLen
      if (pad > 0) rowSegments.push({ text: ' '.repeat(pad) })
    }
    const text = rowSegments.map((segment) => segment.text).join('')
    const plain = rowSegments.every(isPlainSegment)
    lines.push(plain ? { text } : { text, segments: rowSegments })
  }
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
    const plain = styled.every(isPlainSegment)
    lines.push(plain ? { text: `${hang}${text}` } : { text: `${hang}${text}`, segments: [{ text: hang }, ...styled] })
  })
}

const INLINE_TOKEN =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+?)\*\*|(?<!\*)\*(?!\*)(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)|(?<![A-Za-z0-9_])_(?!\s)([^_\n]+?)(?<!\s)_(?![A-Za-z0-9_])/g

/** Inline markup: `` `code` ``, `[label](url)`, `**bold**`, and `*italic*` / `_italic_`. */
function inlineSegments(text: string, activeTheme: TuiTheme): LineSegment[] {
  const segments: LineSegment[] = []
  let last = 0

  for (const match of text.matchAll(INLINE_TOKEN)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index) })
    if (match[1] !== undefined) {
      segments.push({ text: match[1], color: activeTheme.success })
    } else if (match[2] !== undefined && match[3] !== undefined) {
      segments.push({ text: match[2], color: activeTheme.accent, underline: true })
      segments.push({ text: ` (${match[3]})`, color: activeTheme.muted })
    } else if (match[4] !== undefined) {
      segments.push({ text: match[4], bold: true })
    } else if (match[5] !== undefined) {
      segments.push({ text: match[5], italic: true })
    } else if (match[6] !== undefined) {
      segments.push({ text: match[6], italic: true })
    }
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
    if (
      last &&
      Boolean(last.bold) === Boolean(style.bold) &&
      Boolean(last.italic) === Boolean(style.italic) &&
      Boolean(last.underline) === Boolean(style.underline) &&
      last.color === style.color
    ) {
      last.text += text
    } else {
      const next: LineSegment = { text }
      if (style.bold) next.bold = true
      if (style.italic) next.italic = true
      if (style.underline) next.underline = true
      if (style.color) next.color = style.color
      line.push(next)
    }
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
    const style = styleOf[at]!
    // Whether a space stood before this word. Punctuation that follows a span —
    // `**cuidado**.` — had none, and must not gain one.
    const spaced = at > 0 && /\s/.test(plain[at - 1]!)

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
