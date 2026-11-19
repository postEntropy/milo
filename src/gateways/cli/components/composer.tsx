import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, usePaste } from 'ink'
import { formatBotAvatarBadge, resolveBotAvatar } from '../../../core/crew.js'
import type { BotAuthor } from '../../../core/providers/types.js'
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
  bots?: BotAuthor[]
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

interface CommandMatchResult {
  matches: CommandEntry[]
  total: number
}

function matchCommands(value: string, commands: CommandEntry[] | undefined, maxRows: number): CommandMatchResult {
  if (!commands || commands.length === 0 || maxRows <= 0) return { matches: [], total: 0 }
  if (!value.startsWith('/') || value.includes('\n')) return { matches: [], total: 0 }
  const rest = value.slice(1)
  if (/\s/.test(rest)) return { matches: [], total: 0 }
  const query = rest.toLowerCase()
  if (!query) return { matches: commands.slice(0, maxRows), total: commands.length }
  const prefix: CommandEntry[] = []
  const contains: CommandEntry[] = []
  for (const cmd of commands) {
    const lower = cmd.name.toLowerCase()
    if (lower.startsWith(query)) prefix.push(cmd)
    else if (lower.includes(query)) contains.push(cmd)
  }
  const all = [...prefix, ...contains]
  return { matches: all.slice(0, maxRows), total: all.length }
}

type TokenKind = 'normal' | 'command' | 'mention'

interface TokenRange {
  start: number
  end: number
  kind: Exclude<TokenKind, 'normal'>
}

interface StyledChunk {
  start: number
  text: string
  kind: TokenKind
}

/** Finds inline `/command` prefix and `@file` mention ranges within `value`. */
function findInlineTokens(value: string): { tokens: TokenRange[]; mentionCount: number } {
  const tokens: TokenRange[] = []
  let mentionCount = 0

  if (value.startsWith('/')) {
    const cmdMatch = /^\/\S+/.exec(value)
    if (cmdMatch) {
      tokens.push({ start: 0, end: cmdMatch[0].length, kind: 'command' })
    }
  }

  const mentionPattern = /@"[^"\n]+"|@[^\s\n]+/g
  for (const match of value.matchAll(mentionPattern)) {
    const start = match.index ?? 0
    if (start > 0 && !/[\s([{"']/.test(value[start - 1]!)) continue
    const end = start + match[0].length
    if (tokens.some((tok) => start < tok.end && end > tok.start)) continue
    tokens.push({ start, end, kind: 'mention' })
    mentionCount += 1
  }

  tokens.sort((a, b) => a.start - b.start)
  return { tokens, mentionCount }
}

function sliceStyledChunks(value: string, sliceStart: number, sliceEnd: number, tokens: TokenRange[]): StyledChunk[] {
  if (sliceEnd <= sliceStart) return []
  const chunks: StyledChunk[] = []
  let pos = sliceStart

  for (const tok of tokens) {
    if (tok.end <= pos) continue
    if (tok.start >= sliceEnd) break
    if (tok.start > pos) {
      chunks.push({ start: pos, text: value.slice(pos, tok.start), kind: 'normal' })
    }
    const overlapStart = Math.max(pos, tok.start)
    const overlapEnd = Math.min(sliceEnd, tok.end)
    if (overlapEnd > overlapStart) {
      chunks.push({ start: overlapStart, text: value.slice(overlapStart, overlapEnd), kind: tok.kind })
      pos = overlapEnd
    }
  }

  if (pos < sliceEnd) {
    chunks.push({ start: pos, text: value.slice(pos, sliceEnd), kind: 'normal' })
  }

  return chunks
}

function tokenKindAt(offset: number, tokens: TokenRange[]): TokenKind {
  for (const tok of tokens) {
    if (offset >= tok.start && offset < tok.end) return tok.kind
    if (tok.start > offset) break
  }
  return 'normal'
}

function renderStyledChunks(chunks: StyledChunk[], keyPrefix: string) {
  return chunks.map((chunk) => {
    if (chunk.kind === 'command') {
      return (
        <Text key={`${keyPrefix}:${chunk.start}`} bold>
          {chunk.text}
        </Text>
      )
    }
    if (chunk.kind === 'mention') {
      return (
        <Text key={`${keyPrefix}:${chunk.start}`} bold underline>
          {chunk.text}
        </Text>
      )
    }
    return chunk.text
  })
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
  bots = [],
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
  const [totalFileMatches, setTotalFileMatches] = useState(0)
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
  // Reserve 2 rows for the floating popup's 1-line title header and `marginBottom={1}` gap when >=3 rows fit.
  const hasPopupChrome = effectivePopupCap >= 3
  const itemCap = hasPopupChrome ? effectivePopupCap - 2 : effectivePopupCap
  const commandResult = useMemo(() => matchCommands(value, commands, itemCap), [value, commands, itemCap])
  const commandMatches = commandResult.matches
  const atMention = useMemo(
    () => (commandMatches.length > 0 || itemCap <= 0 ? null : findAtMention(value, clampedCursor)),
    [commandMatches.length, itemCap, value, clampedCursor],
  )

  const mentionQuery = atMention?.query ?? null

  useEffect(() => {
    if (!suggestFiles || mentionQuery === null || itemCap <= 0) {
      suggestSeqRef.current += 1
      setFileMatches([])
      setTotalFileMatches(0)
      return
    }
    const seq = ++suggestSeqRef.current
    const query = mentionQuery
    let active = true
    void Promise.resolve(suggestFiles(query))
      .then((results) => {
        if (!active || seq !== suggestSeqRef.current) return
        setTotalFileMatches(results.length)
        setFileMatches(results.slice(0, itemCap))
      })
      .catch(() => {
        if (!active || seq !== suggestSeqRef.current) return
        setFileMatches([])
        setTotalFileMatches(0)
      })
    return () => {
      active = false
    }
  }, [suggestFiles, mentionQuery, itemCap])

  const botMatches = useMemo(() => {
    if (!atMention || itemCap <= 0 || bots.length === 0) return []
    const needle = mentionQuery?.trim().toLowerCase() ?? ''
    return bots
      .filter((bot) => {
        const handle = bot.handle?.toLowerCase() ?? ''
        if (!handle) return false
        return !needle || handle.includes(needle) || bot.name.toLowerCase().includes(needle)
      })
      .slice(0, itemCap)
  }, [atMention, itemCap, bots, mentionQuery])

  const mentionItems = useMemo(() => {
    if (!atMention) return []
    const remaining = Math.max(0, itemCap - botMatches.length)
    return [
      ...botMatches.map((bot) => ({ kind: 'bot' as const, bot, insertion: bot.handle! })),
      ...fileMatches.slice(0, remaining).map((filePath) => ({ kind: 'file' as const, path: filePath, insertion: filePath })),
    ]
  }, [atMention, itemCap, botMatches, fileMatches])

  const popupKind: 'command' | 'file' | null =
    commandMatches.length > 0
      ? 'command'
      : atMention && mentionItems.length > 0
        ? 'file'
        : null
  const popupKey =
    popupKind === 'command'
      ? `cmd:${value}`
      : popupKind === 'file' && atMention
        ? `file:${atMention.start}:${atMention.query}`
        : null
  const popupOpen = popupKind !== null && popupKey !== dismissedKey

  const popupCount = popupKind === 'command' ? commandMatches.length : mentionItems.length
  const popupTotalRows = popupOpen ? popupCount + (hasPopupChrome ? 2 : 0) : 0
  const safePopupIndex = Math.min(popupIndex, Math.max(0, popupCount - 1))

  useEffect(() => {
    onPopupRowsChange?.(popupTotalRows)
  }, [popupTotalRows, onPopupRowsChange])

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
          const picked = mentionItems[safePopupIndex]
          if (picked) completeFile(picked.insertion)
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
            const picked = mentionItems[safePopupIndex]
            if (picked) {
              completeFile(picked.insertion)
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
  const innerWidth = Math.max(1, columns - 4)
  const popupWidth = Math.max(10, columns - 4)
  const inlineInfo = useMemo(() => findInlineTokens(value), [value])
  const attachmentBadge = inlineInfo.mentionCount > 0 ? `📎 ${inlineInfo.mentionCount}` : ''
  const promptColor = busy ? undefined : activeTheme.surfaceText

  const popupTitle =
    popupKind === 'command'
      ? `Commands (${commandResult.total})`
      : botMatches.length > 0 && fileMatches.length === 0
        ? `Crew bots (${botMatches.length})`
        : botMatches.length > 0
          ? `Bots & Files (${botMatches.length + totalFileMatches})`
          : `Files (${totalFileMatches})`
  const popupHint = 'Tab complete'
  const showPopupHint = popupWidth >= popupTitle.length + popupHint.length + 2
  const cmdLabels = commandMatches.map((cmd) => `/${cmd.name}${cmd.usage ?? ''}`)
  const maxCmdLabelLen = Math.min(
    Math.max(8, Math.floor(popupWidth * 0.45)),
    Math.max(0, ...cmdLabels.map((label) => label.length)),
  )

  return (
    <Box flexDirection="column" width={columns}>
      {popupOpen && (
        <Box
          flexDirection="column"
          backgroundColor={activeTheme.surface}
          paddingX={2}
          marginBottom={hasPopupChrome ? 1 : 0}
          width={columns}
        >
          {hasPopupChrome && (
            <Box justifyContent="space-between" width={popupWidth}>
              <Text bold color={activeTheme.surfaceText}>
                {popupTitle}
              </Text>
              {showPopupHint ? <Text color={activeTheme.surfaceText}>{popupHint}</Text> : null}
            </Box>
          )}

          {popupKind === 'command'
            ? commandMatches.map((cmd, index) => {
                const selected = index === safePopupIndex
                const prefix = selected ? '▸ ' : '  '
                const label = truncateLine(cmdLabels[index]!, maxCmdLabelLen).padEnd(maxCmdLabelLen)
                const hintRoom = Math.max(0, popupWidth - prefix.length - label.length - 2)
                const hint = hintRoom > 4 ? `  ${truncateLine(cmd.hint, hintRoom)}` : ''
                const rowLen = prefix.length + label.length + hint.length
                const pad = selected ? ' '.repeat(Math.max(0, popupWidth - rowLen)) : ''
                return (
                  <Box key={cmd.name} width={popupWidth}>
                    <Text inverse={selected} bold={selected} wrap="truncate">
                      {prefix}
                      {label}
                      {hint ? (
                        <Text color={selected ? undefined : activeTheme.surfaceText}>{hint}</Text>
                      ) : null}
                      {pad}
                    </Text>
                  </Box>
                )
              })
            : mentionItems.map((entry, index) => {
                const selected = index === safePopupIndex
                const prefix = selected ? '▸ ' : '  '
                const label =
                  entry.kind === 'bot'
                    ? `@${entry.insertion} · ${formatBotAvatarBadge(resolveBotAvatar(entry.bot))} ${entry.bot.name}`
                    : `@${entry.path}`
                const shown = truncateLine(label, Math.max(1, popupWidth - prefix.length))
                const rowText = `${prefix}${shown}`
                const pad = selected ? ' '.repeat(Math.max(0, popupWidth - rowText.length)) : ''
                return (
                  <Box key={entry.kind === 'bot' ? `bot:${entry.bot.id}` : `file:${entry.path}`} width={popupWidth}>
                    <Text inverse={selected} bold={selected} wrap="truncate">
                      {rowText}
                      {pad}
                    </Text>
                  </Box>
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
          <Box width={innerWidth}>
            <Text bold color={promptColor}>
              ›{' '}
            </Text>
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
            const hasCharAtCursor = isCursorRow && cursorPos.col < line.content.length
            const trailingCursorCols = isCursorRow && !hasCharAtCursor ? 1 : 0
            const usedCols = 2 + line.content.length + trailingCursorCols
            const showBadge =
              offset === visibleSlice.length - 1 &&
              attachmentBadge !== '' &&
              usedCols + attachmentBadge.length + 2 <= innerWidth

            const contentNode = !isCursorRow ? (
              <Text>
                {line.content.length > 0
                  ? renderStyledChunks(
                      sliceStyledChunks(value, line.start, line.end, inlineInfo.tokens),
                      `l${rowIndex}`,
                    )
                  : ' '}
              </Text>
            ) : (
              (() => {
                const cursorBoundary = hasCharAtCursor
                  ? nextCharBoundary(line.content, cursorPos.col)
                  : cursorPos.col
                const beforeChunks = sliceStyledChunks(
                  value,
                  line.start,
                  line.start + cursorPos.col,
                  inlineInfo.tokens,
                )
                const atCursor = hasCharAtCursor
                  ? line.content.slice(cursorPos.col, cursorBoundary)
                  : ' '
                const cursorKind = hasCharAtCursor
                  ? tokenKindAt(line.start + cursorPos.col, inlineInfo.tokens)
                  : 'normal'
                const afterChunks = hasCharAtCursor
                  ? sliceStyledChunks(
                      value,
                      line.start + cursorBoundary,
                      line.end,
                      inlineInfo.tokens,
                    )
                  : []
                return (
                  <Text>
                    {renderStyledChunks(beforeChunks, `b${rowIndex}`)}
                    <Text
                      inverse
                      bold={cursorKind !== 'normal'}
                      underline={cursorKind === 'mention'}
                    >
                      {atCursor}
                    </Text>
                    {renderStyledChunks(afterChunks, `a${rowIndex}`)}
                  </Text>
                )
              })()
            )

            return (
              <Box
                key={`${line.paragraph}:${line.start}`}
                width={innerWidth}
                justifyContent={showBadge ? 'space-between' : undefined}
              >
                <Box>
                  <Text bold={rowIndex === 0} color={rowIndex === 0 ? promptColor : undefined}>
                    {prefix}
                  </Text>
                  {contentNode}
                </Box>
                {showBadge ? <Text color={activeTheme.surfaceText}>{attachmentBadge}</Text> : null}
              </Box>
            )
          })
        )}
      </Box>
    </Box>
  )
}
