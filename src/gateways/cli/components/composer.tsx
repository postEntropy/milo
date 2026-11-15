import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import type { CommandEntry } from '../../command-catalog.js'
import { isCtrlC, isSteerKey } from '../keys.js'
import { theme, type TuiTheme } from '../theme.js'

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (text: string, steer: boolean) => void
  onRecallHistory?: (dir: -1 | 1) => void
  onScroll?: (delta: number) => void
  onPopupRowsChange?: (rows: number) => void
  commands?: CommandEntry[]
  suggestFiles?: (query: string) => string[] | Promise<string[]>
  busy?: boolean
  disabled?: boolean
  columns: number
  maxVisibleLines?: number
  maxPopupRows?: number
  theme?: TuiTheme
  placeholder?: string
}

interface VisualLine {
  paragraph: number
  start: number
  end: number
  wrapped: boolean
  content: string
}

const MAX_VISIBLE_LINES = 6
const MAX_POPUP_ROWS = 6
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function prevCharBoundary(text: string, pos: number): number {
  if (pos <= 0) return 0
  if (pos >= 2 && isLowSurrogate(text.charCodeAt(pos - 1)) && isHighSurrogate(text.charCodeAt(pos - 2))) {
    return pos - 2
  }
  return pos - 1
}

function nextCharBoundary(text: string, pos: number): number {
  if (pos >= text.length) return text.length
  if (pos + 1 < text.length && isHighSurrogate(text.charCodeAt(pos)) && isLowSurrogate(text.charCodeAt(pos + 1))) {
    return pos + 2
  }
  return pos + 1
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch)
}

function wordLeftOffset(text: string, pos: number): number {
  let i = pos
  while (i > 0 && !isWordChar(text.slice(prevCharBoundary(text, i), i))) {
    i = prevCharBoundary(text, i)
  }
  while (i > 0 && isWordChar(text.slice(prevCharBoundary(text, i), i))) {
    i = prevCharBoundary(text, i)
  }
  return i
}

function wordRightOffset(text: string, pos: number): number {
  let i = pos
  while (i < text.length && !isWordChar(text.slice(i, nextCharBoundary(text, i)))) {
    i = nextCharBoundary(text, i)
  }
  while (i < text.length && isWordChar(text.slice(i, nextCharBoundary(text, i)))) {
    i = nextCharBoundary(text, i)
  }
  return i
}

function deleteWordLeftRange(text: string, pos: number): { value: string; cursor: number } {
  if (pos <= 0) return { value: text, cursor: 0 }
  let i = pos
  while (i > 0 && /\s/.test(text[i - 1]!)) {
    i = prevCharBoundary(text, i)
  }
  while (i > 0 && !/\s/.test(text[i - 1]!)) {
    i = prevCharBoundary(text, i)
  }
  return {
    value: text.slice(0, i) + text.slice(pos),
    cursor: i,
  }
}

function lineStartOffset(text: string, pos: number): number {
  if (pos <= 0) return 0
  const prevNl = text.lastIndexOf('\n', pos - 1)
  return prevNl === -1 ? 0 : prevNl + 1
}

function lineEndOffset(text: string, pos: number): number {
  const nextNl = text.indexOf('\n', pos)
  return nextNl === -1 ? text.length : nextNl
}

/**
 * Wraps `text` into visual lines of at most `width` code units, breaking at
 * whitespace when possible and preserving every character offset so cursor
 * mapping stays lossless.
 */
export function wrapComposerLines(text: string, width: number): VisualLine[] {
  const limit = Math.max(1, width)
  const out: VisualLine[] = []
  let paraStart = 0
  let paragraph = 0

  while (true) {
    const nl = text.indexOf('\n', paraStart)
    const paraEnd = nl === -1 ? text.length : nl

    if (paraStart === paraEnd) {
      out.push({ paragraph, start: paraStart, end: paraStart, wrapped: false, content: '' })
    } else {
      let pos = paraStart
      while (pos < paraEnd) {
        if (paraEnd - pos <= limit) {
          out.push({
            paragraph,
            start: pos,
            end: paraEnd,
            wrapped: false,
            content: text.slice(pos, paraEnd),
          })
          pos = paraEnd
        } else {
          let breakAt = -1
          for (let i = pos + limit - 1; i > pos; i -= 1) {
            if (text[i] === ' ' || text[i] === '\t') {
              breakAt = i + 1
              break
            }
          }
          if (breakAt === -1) {
            breakAt = pos + limit
            if (
              breakAt > pos + 1 &&
              isHighSurrogate(text.charCodeAt(breakAt - 1)) &&
              isLowSurrogate(text.charCodeAt(breakAt))
            ) {
              breakAt -= 1
            }
          }
          out.push({
            paragraph,
            start: pos,
            end: breakAt,
            wrapped: true,
            content: text.slice(pos, breakAt),
          })
          pos = breakAt
        }
      }
    }

    if (nl === -1) break
    paraStart = nl + 1
    paragraph += 1
  }

  return out
}

function cursorVisualPosition(lines: VisualLine[], cursor: number): { row: number; col: number } {
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row]!
    if (line.wrapped) {
      if (cursor >= line.start && cursor < line.end) return { row, col: cursor - line.start }
    } else if (cursor >= line.start && cursor <= line.end) {
      return { row, col: cursor - line.start }
    }
  }
  const lastRow = Math.max(0, lines.length - 1)
  const lastLine = lines[lastRow]
  return { row: lastRow, col: lastLine ? lastLine.content.length : 0 }
}

function offsetForVisualPosition(lines: VisualLine[], row: number, col: number): number {
  const line = lines[row]
  if (!line) return 0
  if (line.wrapped) {
    const maxCol = Math.max(0, line.end - line.start - 1)
    return line.start + Math.min(col, maxCol)
  }
  return Math.min(line.start + col, line.end)
}

interface AtMention {
  start: number
  end: number
  query: string
}

function findAtMention(value: string, cursor: number): AtMention | null {
  let i = cursor
  while (i > 0 && !/\s/.test(value[i - 1]!)) {
    i -= 1
  }
  if (i >= cursor) return null
  if (value[i] !== '@') return null
  if (i > 0 && !/[\s([{"']/.test(value[i - 1]!)) return null
  return {
    start: i,
    end: cursor,
    query: value.slice(i + 1, cursor),
  }
}

function matchCommands(value: string, commands: CommandEntry[] | undefined, maxRows: number): CommandEntry[] {
  if (!commands || commands.length === 0 || maxRows <= 0) return []
  if (!value.startsWith('/') || value.includes('\n')) return []
  const rest = value.slice(1)
  if (/\s/.test(rest)) return []
  const query = rest.toLowerCase()
  if (!query) return commands.slice(0, maxRows)
  const prefix: CommandEntry[] = []
  const contains: CommandEntry[] = []
  for (const cmd of commands) {
    const lower = cmd.name.toLowerCase()
    if (lower.startsWith(query)) prefix.push(cmd)
    else if (lower.includes(query)) contains.push(cmd)
  }
  return [...prefix, ...contains].slice(0, maxRows)
}

function normalizePastedText(raw: string): string {
  return raw
    .replaceAll(PASTE_START, '')
    .replaceAll(PASTE_END, '')
    .replace(/\r\n?/g, '\n')
}

function formatMentionInsertion(match: string): string {
  return /\s/.test(match) ? `@"${match}" ` : `@${match} `
}

export function truncateLine(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (text.length <= maxWidth) return text
  if (maxWidth === 1) return text.slice(0, 1)
  return `${text.slice(0, maxWidth - 1)}…`
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onRecallHistory,
  onScroll,
  onPopupRowsChange,
  commands,
  suggestFiles,
  busy = false,
  disabled = false,
  columns,
  maxVisibleLines = MAX_VISIBLE_LINES,
  maxPopupRows = MAX_POPUP_ROWS,
  theme: activeTheme = theme,
  placeholder,
}: ComposerProps) {
  const [cursor, setCursor] = useState(value.length)
  const [popupIndex, setPopupIndex] = useState(0)
  const [fileMatches, setFileMatches] = useState<string[]>([])
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  const [scrollRow, setScrollRow] = useState(0)

  const lastInternalValueRef = useRef(value)
  const [prevExternalValue, setPrevExternalValue] = useState(value)
  const preferredColRef = useRef<number | null>(null)
  const suggestSeqRef = useRef(0)

  if (value !== prevExternalValue) {
    setPrevExternalValue(value)
    if (value !== lastInternalValueRef.current) {
      lastInternalValueRef.current = value
      setCursor(value.length)
      preferredColRef.current = null
    }
  }

  const clampedCursor = Math.min(Math.max(0, cursor), value.length)
  // Leave 4 columns for `paddingX={2}`, 2 for `'› '` / `'  '`, and 1 for a trailing cursor block.
  const textWidth = Math.max(1, columns - 7)
  const visualLines = useMemo(() => wrapComposerLines(value, textWidth), [value, textWidth])
  const cursorPos = useMemo(
    () => cursorVisualPosition(visualLines, clampedCursor),
    [visualLines, clampedCursor],
  )

  const visibleRowCount = Math.min(Math.max(1, maxVisibleLines), Math.max(1, visualLines.length))
  const maxScrollRow = Math.max(0, visualLines.length - visibleRowCount)
  let nextScrollRow = Math.min(scrollRow, maxScrollRow)
  if (cursorPos.row < nextScrollRow) nextScrollRow = cursorPos.row
  else if (cursorPos.row >= nextScrollRow + visibleRowCount) {
    nextScrollRow = cursorPos.row - visibleRowCount + 1
  }
  if (nextScrollRow !== scrollRow) {
    setScrollRow(nextScrollRow)
  }

  const effectivePopupCap = Math.max(0, maxPopupRows)
  const commandMatches = useMemo(() => matchCommands(value, commands, effectivePopupCap), [value, commands, effectivePopupCap])
  const atMention = useMemo(
    () => (commandMatches.length > 0 || effectivePopupCap <= 0 ? null : findAtMention(value, clampedCursor)),
    [commandMatches.length, effectivePopupCap, value, clampedCursor],
  )

  const mentionQuery = atMention?.query ?? null

  useEffect(() => {
    if (!suggestFiles || mentionQuery === null || effectivePopupCap <= 0) {
      suggestSeqRef.current += 1
      setFileMatches([])
      return
    }
    const seq = ++suggestSeqRef.current
    const query = mentionQuery
    let active = true
    void Promise.resolve(suggestFiles(query))
      .then((results) => {
        if (!active || seq !== suggestSeqRef.current) return
        setFileMatches(results.slice(0, effectivePopupCap))
      })
      .catch(() => {
        if (!active || seq !== suggestSeqRef.current) return
        setFileMatches([])
      })
    return () => {
      active = false
    }
  }, [suggestFiles, mentionQuery, effectivePopupCap])

  const popupKind: 'command' | 'file' | null =
    commandMatches.length > 0
      ? 'command'
      : atMention && fileMatches.length > 0
        ? 'file'
        : null
  const popupKey =
    popupKind === 'command'
      ? `cmd:${value}`
      : popupKind === 'file' && atMention
        ? `file:${atMention.start}:${atMention.query}`
        : null
  const popupOpen = popupKind !== null && popupKey !== dismissedKey

  const popupCount = popupKind === 'command' ? commandMatches.length : fileMatches.length
  const safePopupIndex = Math.min(popupIndex, Math.max(0, popupCount - 1))

  useEffect(() => {
    onPopupRowsChange?.(popupOpen ? popupCount : 0)
  }, [popupOpen, popupCount, onPopupRowsChange])

  const [prevPopupKey, setPrevPopupKey] = useState<string | null>(popupKey)
  if (popupKey !== prevPopupKey) {
    setPrevPopupKey(popupKey)
    setPopupIndex(0)
  }

  const applyEdit = (nextValue: string, nextCursor: number) => {
    lastInternalValueRef.current = nextValue
    preferredColRef.current = null
    setDismissedKey(null)
    setCursor(nextCursor)
    onChange(nextValue)
  }

  const insertAtCursor = (snippet: string) => {
    const clean = normalizePastedText(snippet)
    if (!clean) return
    const nextValue = value.slice(0, clampedCursor) + clean + value.slice(clampedCursor)
    applyEdit(nextValue, clampedCursor + clean.length)
  }

  const completeCommand = (cmd: CommandEntry) => {
    const completed = `/${cmd.name} `
    applyEdit(completed, completed.length)
  }

  const completeFile = (match: string) => {
    if (!atMention) return
    const insertion = formatMentionInsertion(match)
    const nextValue = value.slice(0, atMention.start) + insertion + value.slice(atMention.end)
    applyEdit(nextValue, atMention.start + insertion.length)
  }

  usePaste(
    (pasted) => {
      insertAtCursor(pasted)
    },
    { isActive: !disabled },
  )

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return
      if (isCtrlC(input, key)) return

      // Mouse wheel ticks arrive as Alt+Up/Down via mouse.ts.
      if (key.meta && (key.upArrow || key.downArrow)) {
        onScroll?.(key.upArrow ? 1 : -1)
        return
      }

      if (key.escape) {
        if (popupOpen && popupKey) {
          setDismissedKey(popupKey)
        }
        return
      }

      if (popupOpen && key.tab) {
        if (popupKind === 'command') {
          const picked = commandMatches[safePopupIndex]
          if (picked) completeCommand(picked)
        } else if (popupKind === 'file') {
          const picked = fileMatches[safePopupIndex]
          if (picked) completeFile(picked)
        }
        return
      }

      // Return: Shift+Enter inserts a newline; Ctrl/Alt+Enter steers; plain Enter completes or submits.
      if (key.return) {
        if (isSteerKey(key)) {
          onSubmit(value, true)
          return
        }
        if (key.shift) {
          insertAtCursor('\n')
          return
        }
        if (popupOpen) {
          if (popupKind === 'command') {
            const picked = commandMatches[safePopupIndex]
            if (picked && value !== `/${picked.name}`) {
              completeCommand(picked)
              return
            }
          } else if (popupKind === 'file') {
            const picked = fileMatches[safePopupIndex]
            if (picked) {
              completeFile(picked)
              return
            }
          }
        }
        onSubmit(value, false)
        return
      }

      // Ctrl+J (linefeed '\n' in legacy terminals or Ctrl+j in Kitty) inserts a newline.
      if (input === '\n' || (key.ctrl && input.toLowerCase() === 'j')) {
        insertAtCursor('\n')
        return
      }

      if (key.upArrow) {
        if (popupOpen) {
          setPopupIndex((idx) => (idx - 1 + popupCount) % popupCount)
          return
        }
        if (cursorPos.row > 0) {
          const targetCol = preferredColRef.current ?? cursorPos.col
          preferredColRef.current = targetCol
          setCursor(offsetForVisualPosition(visualLines, cursorPos.row - 1, targetCol))
        } else {
          onRecallHistory?.(-1)
        }
        return
      }

      if (key.downArrow) {
        if (popupOpen) {
          setPopupIndex((idx) => (idx + 1) % popupCount)
          return
        }
        if (cursorPos.row < visualLines.length - 1) {
          const targetCol = preferredColRef.current ?? cursorPos.col
          preferredColRef.current = targetCol
          setCursor(offsetForVisualPosition(visualLines, cursorPos.row + 1, targetCol))
        } else {
          onRecallHistory?.(1)
        }
        return
      }

      if (key.leftArrow) {
        preferredColRef.current = null
        setCursor(
          key.meta || key.ctrl
            ? wordLeftOffset(value, clampedCursor)
            : prevCharBoundary(value, clampedCursor),
        )
        return
      }

      if (key.rightArrow) {
        preferredColRef.current = null
        setCursor(
          key.meta || key.ctrl
            ? wordRightOffset(value, clampedCursor)
            : nextCharBoundary(value, clampedCursor),
        )
        return
      }

      if (key.meta && input.toLowerCase() === 'b') {
        preferredColRef.current = null
        setCursor(wordLeftOffset(value, clampedCursor))
        return
      }

      if (key.meta && input.toLowerCase() === 'f') {
        preferredColRef.current = null
        setCursor(wordRightOffset(value, clampedCursor))
        return
      }

      if (key.home || (key.ctrl && input.toLowerCase() === 'a')) {
        preferredColRef.current = null
        setCursor(lineStartOffset(value, clampedCursor))
        return
      }

      if (key.end || (key.ctrl && input.toLowerCase() === 'e')) {
        preferredColRef.current = null
        setCursor(lineEndOffset(value, clampedCursor))
        return
      }

      if (key.ctrl && input.toLowerCase() === 'w') {
        const next = deleteWordLeftRange(value, clampedCursor)
        applyEdit(next.value, next.cursor)
        return
      }

      if (key.ctrl && input.toLowerCase() === 'u') {
        const start = lineStartOffset(value, clampedCursor)
        if (start === clampedCursor) return
        applyEdit(value.slice(0, start) + value.slice(clampedCursor), start)
        return
      }

      if (key.ctrl && input.toLowerCase() === 'k') {
        const end = lineEndOffset(value, clampedCursor)
        const killTo = end === clampedCursor && clampedCursor < value.length ? clampedCursor + 1 : end
        if (killTo === clampedCursor) return
        applyEdit(value.slice(0, clampedCursor) + value.slice(killTo), clampedCursor)
        return
      }

      if (key.backspace) {
        if (key.meta) {
          const next = deleteWordLeftRange(value, clampedCursor)
          applyEdit(next.value, next.cursor)
          return
        }
        if (clampedCursor <= 0) return
        const prev = prevCharBoundary(value, clampedCursor)
        applyEdit(value.slice(0, prev) + value.slice(clampedCursor), prev)
        return
      }

      if (key.delete) {
        if (clampedCursor >= value.length) return
        const next = nextCharBoundary(value, clampedCursor)
        applyEdit(value.slice(0, clampedCursor) + value.slice(next), clampedCursor)
        return
      }

      if (key.pageUp || key.pageDown || key.tab) return
      if (key.ctrl || key.meta) return
      if (!input) return

      // Handle multi-character input (e.g. unbracketed paste) or printable single characters.
      const normalized = normalizePastedText(input)
      if (!normalized) return
      const printable = [...normalized].filter((ch) => ch === '\n' || (ch.codePointAt(0) ?? 0) >= 0x20).join('')
      if (!printable) return
      insertAtCursor(printable)
    },
    { isActive: !disabled },
  )

  const placeholderText =
    placeholder ?? (busy ? 'Queue a message — Ctrl+Enter to steer…' : 'Type a message or @file…')
  const visibleSlice = visualLines.slice(nextScrollRow, nextScrollRow + visibleRowCount)
  const popupWidth = Math.max(10, columns - 4)

  return (
    <Box flexDirection="column" width={columns}>
      {popupOpen && popupKind === 'command' && (
        <Box
          flexDirection="column"
          backgroundColor={activeTheme.surface}
          paddingX={2}
          width={columns}
        >
          {commandMatches.map((cmd, index) => {
            const selected = index === safePopupIndex
            const label = `/${cmd.name}${cmd.usage ?? ''}`
            const hintRoom = Math.max(0, popupWidth - 2 - label.length - 3)
            const hint = hintRoom > 4 ? ` — ${truncateLine(cmd.hint, hintRoom)}` : ''
            return (
              <Text key={cmd.name} bold={selected} wrap="truncate">
                <Text bold={selected}>{selected ? '❯ ' : '  '}</Text>
                <Text bold={selected}>{truncateLine(label, popupWidth - 2)}</Text>
                {hint ? <Text color={activeTheme.surfaceText}>{hint}</Text> : null}
              </Text>
            )
          })}
        </Box>
      )}

      {popupOpen && popupKind === 'file' && (
        <Box
          flexDirection="column"
          backgroundColor={activeTheme.surface}
          paddingX={2}
          width={columns}
        >
          {fileMatches.map((filePath, index) => {
            const selected = index === safePopupIndex
            return (
              <Text key={filePath} bold={selected} wrap="truncate">
                <Text bold={selected}>{selected ? '❯ ' : '  '}</Text>
                <Text bold={selected}>@{truncateLine(filePath, popupWidth - 3)}</Text>
              </Text>
            )
          })}
        </Box>
      )}

      <Box
        flexDirection="column"
        backgroundColor={activeTheme.surface}
        paddingX={2}
        paddingY={1}
        width={columns}
        height={visibleRowCount + 2}
        overflow="hidden"
      >
        {value === '' ? (
          <Box width={Math.max(1, columns - 4)}>
            <Text bold>› </Text>
            {!disabled && <Text inverse> </Text>}
            <Text color={activeTheme.surfaceText}>
              {truncateLine(placeholderText, Math.max(1, textWidth))}
            </Text>
          </Box>
        ) : (
          visibleSlice.map((line, offset) => {
            const rowIndex = nextScrollRow + offset
            const prefix = rowIndex === 0 ? '› ' : '  '
            const isCursorRow = !disabled && rowIndex === cursorPos.row

            if (!isCursorRow) {
              return (
                <Box key={`${line.paragraph}:${line.start}`} width={Math.max(1, columns - 4)}>
                  <Text bold={rowIndex === 0}>{prefix}</Text>
                  <Text>{line.content || ' '}</Text>
                </Box>
              )
            }

            const before = line.content.slice(0, cursorPos.col)
            const hasCharAtCursor = cursorPos.col < line.content.length
            const cursorBoundary = hasCharAtCursor
              ? nextCharBoundary(line.content, cursorPos.col)
              : cursorPos.col
            const atCursor = hasCharAtCursor ? line.content.slice(cursorPos.col, cursorBoundary) : ' '
            const after = hasCharAtCursor ? line.content.slice(cursorBoundary) : ''

            return (
              <Box key={`${line.paragraph}:${line.start}`} width={Math.max(1, columns - 4)}>
                <Text bold={rowIndex === 0}>{prefix}</Text>
                <Text>
                  {before}
                  <Text inverse>{atCursor}</Text>
                  {after}
                </Text>
              </Box>
            )
          })
        )}
      </Box>
    </Box>
  )
}
