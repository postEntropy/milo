import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'
import type { AgentEvent } from '../../../core/agent/events.js'
import type { DisplayConfig } from '../../../core/config/schema.js'
import type { MemoryScope } from '../../../core/memory/index.js'
import type { AgentRuntime } from '../../../core/runtime.js'
import { formatSessionList, formatStats } from '../../../core/sessions/index.js'
import type {
  PermissionAsker,
  PermissionMode,
  PermissionRequest,
  PermissionResult,
} from '../../../core/tools/permission.js'
import { errorMessage } from '../../../util/errors.js'
import { isCtrlC } from '../keys.js'
import { theme } from '../theme.js'
import { buildLines, padToBottom, visibleWindow, wrapText, type Item, type Line } from '../transcript.js'
import { useElapsed } from '../use-elapsed.js'
import { useTerminalSize } from '../use-terminal-size.js'

type Phase = 'idle' | 'thinking' | 'writing' | 'tool' | 'asking'

const HEADER_ROWS = 3
const CHROME_ROWS = 2
const MAX_REASONING_ROWS = 5
const PERMISSION_ROWS = 2

export interface ChatScreenProps {
  runtime: AgentRuntime
  scope: MemoryScope
  mode: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  /** How much of a tool call to show, and whether to show thinking. */
  display: DisplayConfig
  onDisplayChange: (patch: Partial<DisplayConfig>) => void
  /** The transcript lives in the shell so switching screens does not drop it. */
  items: Item[]
  setItems: Dispatch<SetStateAction<Item[]>>
  onOpenModel: () => void
  onOpenSettings: () => void
  onExit: () => void
  onBusyChange?: (busy: boolean) => void
  /** Fired when /new or /resume rebinds this conversation to another session. */
  onSessionChange?: (id: string) => void
}

const HELP_TEXT =
  'Commands: /model · /setup · /mode ask|auto|yolo · /yolo · /tools full|name|off · ' +
  '/thinking on|off · /new [title] · /sessions · /resume <id> · /stats · /clear · /help · /exit'

export function ChatScreen({
  runtime,
  scope,
  mode,
  onModeChange,
  display,
  onDisplayChange,
  items,
  setItems,
  onOpenModel,
  onOpenSettings,
  onExit,
  onBusyChange,
  onSessionChange,
}: ChatScreenProps) {
  const { exit } = useApp()
  const { rows, columns } = useTerminalSize()

  const [live, setLive] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [toolName, setToolName] = useState('')
  const [input, setInput] = useState('')
  const [tokens, setTokens] = useState(0)
  const [lastDuration, setLastDuration] = useState<number | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)

  const busy = phase !== 'idle'
  const elapsed = useElapsed(busy, startedAt)

  const abortRef = useRef<AbortController | null>(null)
  const toolArgsRef = useRef<unknown>({})
  const permissionResolverRef = useRef<((result: PermissionResult) => void) | null>(null)

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  const ask = useCallback<PermissionAsker>((request) => {
    setPermission(request)
    setPhase('asking')
    return new Promise<PermissionResult>((resolve) => {
      permissionResolverRef.current = resolve
    })
  }, [])

  const resolvePermission = (allowed: boolean) => {
    const resolve = permissionResolverRef.current
    permissionResolverRef.current = null
    setPermission(null)
    setPhase('thinking')
    resolve?.({ allowed })
  }

  const width = Math.max(20, columns - 2)
  const reasonLines = useMemo(
    () => (display.thinking && reasoning ? wrapText(reasoning, width - 2) : []),
    [display.thinking, reasoning, width],
  )
  const reasonPreview = busy ? reasonLines.slice(-MAX_REASONING_ROWS) : []
  const reasoningRows = reasonPreview.length

  const chatHeight = Math.max(
    3,
    rows - HEADER_ROWS - CHROME_ROWS - reasoningRows - (permission ? PERMISSION_ROWS : 0),
  )

  const displayItems = useMemo<Item[]>(
    () => (live !== '' ? [...items, { kind: 'assistant', text: live }] : items),
    [items, live],
  )
  const window = useMemo(
    () => visibleWindow(buildLines(displayItems, width), chatHeight, scrollOffset),
    [displayItems, width, chatHeight, scrollOffset],
  )
  const bodyLines = useMemo<Line[]>(() => {
    if (window.lines.length === 0 && !busy && displayItems.length === 0) {
      return [{ text: 'Ask Milo anything. Type /help for commands.', dim: true }]
    }
    return padToBottom(window.lines, chatHeight)
  }, [window.lines, chatHeight, busy, displayItems.length])

  const push = (item: Item) => setItems((current) => [...current, item])

  useInput((inputChar, key) => {
    if (permission) {
      if (isCtrlC(inputChar, key)) resolvePermission(false)
      else if (inputChar === 'y' || inputChar === 'Y') resolvePermission(true)
      else if (inputChar === 'n' || inputChar === 'N' || key.escape) resolvePermission(false)
      return
    }
    if (isCtrlC(inputChar, key)) {
      if (busy) abortRef.current?.abort()
      else exit()
      return
    }
    if (key.pageUp) setScrollOffset((value) => value + Math.max(1, Math.floor(chatHeight / 2)))
    else if (key.pageDown) {
      setScrollOffset((value) => Math.max(0, value - Math.max(1, Math.floor(chatHeight / 2))))
    }
  })

  const runCommand = async (raw: string) => {
    const [command, ...rest] = raw.slice(1).trim().split(/\s+/)
    const argument = rest.join(' ')
    switch (command) {
      case 'model':
        onOpenModel()
        break
      case 'setup':
        onOpenSettings()
        break
      case 'yolo': {
        const next: PermissionMode = mode === 'yolo' ? 'ask' : 'yolo'
        onModeChange(next)
        push({
          kind: 'info',
          text:
            next === 'yolo'
              ? '⚠ yolo mode ON — tools run without confirmation. /yolo to turn it off.'
              : 'yolo mode off — back to asking before side-effecting tools.',
        })
        break
      }
      case 'mode':
        if (argument === 'ask' || argument === 'auto' || argument === 'yolo') {
          onModeChange(argument)
          push({ kind: 'info', text: `Permission mode: ${argument}` })
        } else {
          push({ kind: 'info', text: `Permission mode: ${mode}. Use /mode ask|auto|yolo` })
        }
        break
      case 'tools': {
        const level = argument.trim().toLowerCase()
        if (level !== 'full' && level !== 'name' && level !== 'off') {
          push({ kind: 'info', text: `Tools: ${display.tools}. Use /tools full|name|off` })
          break
        }
        onDisplayChange({ tools: level })
        push({
          kind: 'info',
          text: `Tools: ${level}${level === 'off' ? ' — a tool that fails is still reported' : ''}`,
        })
        break
      }
      case 'thinking': {
        const asked = argument.trim().toLowerCase()
        const next = asked === 'on' ? true : asked === 'off' ? false : !display.thinking
        onDisplayChange({ thinking: next })
        push({ kind: 'info', text: `Thinking: ${next ? 'on' : 'off'}` })
        break
      }
      case 'new': {
        const session = await runtime.newSession(scope, argument || undefined)
        onSessionChange?.(session.id)
        push({ kind: 'info', text: `New session: ${session.id}` })
        break
      }
      case 'sessions':
        push({ kind: 'info', text: formatSessionList(await runtime.listSessions()) })
        break
      case 'resume': {
        if (!argument) {
          push({ kind: 'info', text: 'Usage: /resume <id>. See /sessions for the ids.' })
          break
        }
        const session = await runtime.resumeSession(scope, argument)
        if (!session) {
          push({ kind: 'info', text: `No session "${argument}". See /sessions for the ids.` })
          break
        }
        onSessionChange?.(session.id)
        push({ kind: 'info', text: `Switched to session ${session.id}.` })
        break
      }
      case 'stats': {
        const session = await runtime.getSession(scope)
        push({ kind: 'info', text: formatStats(session.stats()) })
        break
      }
      case 'clear': {
        const session = await runtime.getSession(scope)
        await session.clear()
        setItems([])
        push({ kind: 'info', text: `Session ${session.id} cleared.` })
        break
      }
      case 'help':
        push({ kind: 'info', text: HELP_TEXT })
        break
      case 'exit':
      case 'quit':
        onExit()
        break
      default:
        push({ kind: 'info', text: `Unknown command: /${command} — try /help` })
    }
  }

  const send = async (text: string) => {
    push({ kind: 'user', text })
    setScrollOffset(0)
    setLive('')
    setReasoning('')
    setToolName('')
    setPhase('thinking')
    setStartedAt(Date.now())

    const controller = new AbortController()
    abortRef.current = controller
    const startedAtMs = Date.now()

    let assistant = ''
    try {
      const session = await runtime.getSession(scope)
      for await (const event of session.send(text, { signal: controller.signal, ask })) {
        applyEvent(event, {
          onText: (delta) => {
            assistant += delta
            setLive(assistant)
            setPhase('writing')
          },
          onReasoning: (delta) => {
            if (display.thinking) setReasoning((value) => value + delta)
          },
          onToolStart: (name, args) => {
            toolArgsRef.current = args
            // `off` keeps tool activity out of the transcript and out of the
            // status line, so the turn reads as plain thinking.
            if (display.tools === 'off') return
            setToolName(name)
            setPhase('tool')
          },
          onToolEnd: (name, isError) => {
            // A failure is always shown, even with tools off.
            if (display.tools !== 'off' || isError) {
              push({
                kind: 'tool',
                name,
                detail: display.tools === 'name' ? '' : formatArgs(toolArgsRef.current),
                ok: !isError,
              })
            }
            setToolName('')
            setPhase('thinking')
          },
          onUsage: (total) => setTokens((value) => value + total),
          onDone: (finishReason) => {
            // A capped answer otherwise looks like a complete one.
            if (finishReason === 'length') {
              push({
                kind: 'info',
                text: '⚠ hit the output limit — the answer was cut off. Raise "maxTokens" in config.json.',
              })
            }
          },
          onAborted: () => push({ kind: 'info', text: 'stopped.' }),
          onError: (message) => push({ kind: 'error', text: message }),
        })
      }
    } catch (error) {
      push({ kind: 'error', text: errorMessage(error) })
    }

    if (assistant.trim()) push({ kind: 'assistant', text: assistant })
    setLive('')
    setReasoning('')
    setToolName('')
    setPermission(null)
    setPhase('idle')
    setLastDuration((Date.now() - startedAtMs) / 1000)
    abortRef.current = null
  }

  const onSubmit = (raw: string) => {
    const text = raw.trim()
    if (!text || busy) return
    setInput('')
    // A command that throws must not become an unhandled rejection: say what
    // broke instead of appearing to ignore the line.
    if (text.startsWith('/')) {
      void runCommand(text).catch((error) => push({ kind: 'error', text: errorMessage(error) }))
    } else {
      void send(text).catch((error) => push({ kind: 'error', text: errorMessage(error) }))
    }
  }

  const statusLabel =
    phase === 'asking'
      ? 'waiting for confirmation'
      : phase === 'tool'
        ? `${toolName}…`
        : phase === 'writing'
          ? 'writing…'
          : 'thinking…'

  return (
    <Box flexDirection="column" height={rows - HEADER_ROWS} width={columns}>
      <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
        {bodyLines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the window is rebuilt every frame and never reorders
          <Text key={index} color={line.color} dimColor={line.dim}>
            {line.segments
              ? line.segments.map((segment, segmentIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments are re-wrapped every frame and never reorder
                  <Text key={segmentIndex} bold={segment.bold}>
                    {segment.text}
                  </Text>
                ))
              : line.text || ' '}
          </Text>
        ))}
      </Box>

      {reasoningRows > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {reasonPreview.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the preview is rebuilt every frame and never reorders
            <Text key={index} dimColor italic>
              {line || ' '}
            </Text>
          ))}
        </Box>
      )}

      {permission ? (
        <Box flexDirection="column" paddingX={1}>
          <Text color={theme.warning}>⚠ Milo wants to run {permission.tool}:</Text>
          <Text color={theme.warning}>  {permission.summary}</Text>
          <Text dimColor>[y] allow · [n] deny</Text>
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color={mode === 'yolo' ? theme.danger : theme.accent}>› </Text>
          {busy ? (
            <Text dimColor>(working — Ctrl+C to stop)</Text>
          ) : (
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={onSubmit}
              placeholder="Type a message…"
            />
          )}
        </Box>
      )}

      <Box paddingX={1} justifyContent="space-between">
        {busy ? (
          <Text color={theme.warning}>
            <Spinner type="dots" /> {statusLabel} {elapsed.toFixed(1)}s
          </Text>
        ) : (
          <Text dimColor>
            {window.offset > 0 ? `▲ scrolled (${window.offset}) · ` : ''}
            PgUp/PgDn scroll · Enter send · /new · /sessions · /help · Ctrl+C quit
          </Text>
        )}
        <Text dimColor>
          {!busy && lastDuration !== null ? `last ${lastDuration.toFixed(1)}s · ` : ''}
          {tokens > 0 ? `${formatTokens(tokens)} tok` : ''}
        </Text>
      </Box>
    </Box>
  )
}

interface EventHandlers {
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
  onToolStart: (name: string, args: unknown) => void
  onToolEnd: (name: string, isError: boolean) => void
  onUsage: (totalTokens: number) => void
  onDone: (finishReason: string) => void
  onAborted: () => void
  onError: (message: string) => void
}

function applyEvent(event: AgentEvent, handlers: EventHandlers): void {
  switch (event.type) {
    case 'text-delta':
      handlers.onText(event.delta)
      break
    case 'reasoning-delta':
      handlers.onReasoning(event.delta)
      break
    case 'tool-start':
      handlers.onToolStart(event.name, event.args)
      break
    case 'tool-end':
      handlers.onToolEnd(event.name, event.isError)
      break
    case 'usage':
      handlers.onUsage(event.inputTokens + event.outputTokens)
      break
    case 'done':
      handlers.onDone(event.finishReason)
      break
    case 'aborted':
      handlers.onAborted()
      break
    case 'error':
      handlers.onError(event.message)
      break
    default:
      break
  }
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
}

function formatArgs(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return args
  try {
    const json = JSON.stringify(args)
    return json.length > 80 ? `${json.slice(0, 77)}…` : json
  } catch {
    return String(args)
  }
}
