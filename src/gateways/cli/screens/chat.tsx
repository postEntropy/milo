import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Box, Text, useApp, useInput } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'
import type { AgentEvent } from '../../../core/agent/events.js'
import type { DisplayConfig } from '../../../core/config/schema.js'
import type { MemoryScope } from '../../../core/memory/index.js'
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type AudioPart,
  type ReasoningEffort,
} from '../../../core/providers/types.js'
import type { AgentRuntime } from '../../../core/runtime.js'
import { prepareIncoming } from '../../../core/media.js'
import type { ImagePart } from '../../../core/providers/types.js'
import { describeRebase, formatWhen, type SessionStats } from '../../../core/sessions/index.js'
import { formatSkillList } from '../../../core/skills/index.js'
import type { TodoItem } from '../../../core/todos.js'
import {
  PERMISSION_LABELS,
  type PermissionAsker,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResult,
} from '../../../core/tools/permission.js'
import { errorMessage } from '../../../util/errors.js'
import { buildSessionsList } from '../../actions.js'
import {
  compactReply,
  formatMemoryList,
  handleTurnControl,
  parseForkArgument,
  type TurnControlTarget,
} from '../../commands.js'
import { isCtrlC, isSteerKey } from '../keys.js'
import { readInputHistory, saveInputHistory } from '../input-history.js'
import { theme, type ThemeColor } from '../theme.js'
import { showsToolCall, toolDetail, toolDisplayName } from '../../tool-line.js'
import { buildLines, padToBottom, visibleWindow, type Item, type Line } from '../transcript.js'
import { useElapsed } from '../use-elapsed.js'
import { useTerminalSize } from '../use-terminal-size.js'

type Phase = 'idle' | 'thinking' | 'writing' | 'tool' | 'asking' | 'waiting'

const HEADER_ROWS = 0
/** The composer line and its breathing room. */
const COMPOSER_ROWS = 3
/** The permission prompt: the question and the key it is waiting on. */
const PERMISSION_ROWS = 3

/**
 * What the turn runs on. Kept in parts rather than as one string: the band under
 * the composer colours each piece for what it is — the model is the value, the
 * provider and the id are the reference — and a single run of text could not.
 */
export interface ModelInfo {
  provider: string
  model: string
  effort: ReasoningEffort
}

/**
 * One field of the band under the composer: an optional muted label, and the value
 * that carries the colour. `effort` is the label and `medium` is the value, so the
 * eye lands on what is set rather than on the word naming it.
 */
interface FooterPart {
  label?: string
  text: string
  color: ThemeColor
  bold?: boolean
}

export interface ChatScreenProps {
  runtime: AgentRuntime
  scope: MemoryScope
  mode: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  /** How hard the model should think; written down, and applied to the next turn. */
  onEffortChange: (effort: ReasoningEffort) => void
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
  model?: ModelInfo
  sessionId?: string | null
  /** Fired when /new or /resume rebinds this conversation to another session. */
  onSessionChange?: (id: string) => void
}

/** Described one per line: a bare list of names leaves the reader to guess. */
const HELP_TEXT = [
  'Commands:',
  '/model — change the provider and model',
  '/provider — switch the provider (same picker)',
  '/setup — the settings hub (keys, display, gateways)',
  '/mode ask|auto|yolo — when a tool needs confirming',
  '/yolo — toggle yolo mode',
  '/tools full|name|off — how much of each tool call to show',
  '/thinking on|off — show or hide the model\'s reasoning in the transcript',
  '  Display only: the model thinks either way; /effort is what changes that.',
  "/effort low|medium|high — how hard the model thinks",
  "  The other axis, and the one that costs: /effort default goes back to the provider's own.",
  '/new [title] — start a new session',
  '/sessions [page] — list saved sessions',
  '/resume <id> — switch to another session',
  '/stats — numbers for the current session',
  '/skills — the skills installed, and where they live',
  '/memory [forget <id>] — what Milo keeps, and how to drop one of them',
  '/clear — forget this conversation',
  '/compact — fold the oldest turns into the summary now',
  '/stop — stop the turn running now, and anything queued behind it',
  '/steer <text> — hand text to the turn running now (Ctrl+Enter does the same)',
  '/queue <text> — say it as its own turn, after the one running now (Enter does the same)',
  '/exit — quit',
  '',
  '↑ walks back through what you sent; ↓ comes forward again.',
].join('\n')

/**
 * The commands a running turn rules out. They rebind the session, empty the
 * transcript it is writing into, or take over the screen its output goes to —
 * so they would fight the turn rather than wait behind it.
 */
const BLOCKED_WHILE_BUSY = new Set(['new', 'resume', 'fork', 'clear', 'model', 'provider', 'setup', 'compact'])

/**
 * How many sent lines the arrows walk back through. Kept in memory, for this
 * run: enough to get back to anything said in a sitting, and nothing left on
 * disk to explain afterwards.
 */
const HISTORY_LIMIT = 200

export function ChatScreen({
  runtime,
  scope,
  mode,
  onModeChange,
  onEffortChange,
  display,
  onDisplayChange,
  items,
  setItems,
  onOpenModel,
  onOpenSettings,
  onExit,
  onBusyChange,
  onSessionChange,
  model,
  sessionId,
}: ChatScreenProps) {
  const { exit } = useApp()
  const { rows, columns } = useTerminalSize()

  const [live, setLive] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [toolName, setToolName] = useState('')
  const [input, setInput] = useState('')
  /** Messages typed while a turn was running, still waiting for it. */
  const [queued, setQueued] = useState(0)
  /**
   * How big the last request was, as the provider counted it: the transcript, the
   * memories and the tool catalog it was handed, in tokens. It is the session's
   * size, not a running total — summing the input of every step of a turn would
   * count the same transcript once per step.
   */
  const [contextTokens, setContextTokens] = useState(0)
  const [lastDuration, setLastDuration] = useState<number | null>(null)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  /** Bumped on every recall, so the input remounts with its cursor at the end. */
  const [recallEpoch, setRecallEpoch] = useState(0)

  const busy = phase !== 'idle'
  const elapsed = useElapsed(busy, startedAt)

  const abortRef = useRef<AbortController | null>(null)
  const toolArgsRef = useRef<unknown>({})
  const permissionResolverRef = useRef<((result: PermissionResult) => void) | null>(null)
  /**
   * The answer still streaming. In a ref as well as in state because a message
   * typed mid-turn has to file what was already said *above* itself — the
   * transcript is built from the finished items plus this live tail, so a new
   * item would otherwise appear before the text that came first.
   */
  const liveRef = useRef('')
  /** The thought being written, in a ref for the same reason: it is committed between renders. */
  const reasoningRef = useRef('')
  /** Messages typed behind the turn in flight, in the order they were typed. */
  const queueRef = useRef<Array<{ text: string; images: ImagePart[]; audio: AudioPart[]; model?: string }>>([])
  /** The running turn's inbox: non-null for exactly as long as one is streaming. */
  const steeringRef = useRef<string[] | null>(null)
  /** True while the pump is working, which spans the gaps between turns. */
  const runningRef = useRef(false)
  /** How many messages Ctrl+C threw away, reported once the turn is over. */
  const droppedRef = useRef(0)
  /** What was sent this run, oldest first; the arrows walk up and down it. */
  const inputHistoryRef = useRef<string[]>([])
  /** Where the arrows are in that history; `null` is the line being typed. */
  const historyIndexRef = useRef<number | null>(null)
  /** What was in the composer before the first Up, handed back on the way down. */
  const draftRef = useRef('')

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  // What was sent on earlier runs is on disk: the arrows should still know the
  // command from yesterday, not only the one from this sitting.
  useEffect(() => {
    inputHistoryRef.current = readInputHistory()
  }, [])

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

  // The width the transcript wraps to: the screen less the two columns each line
  // is inset by, so a line never runs past the edge and gets clipped.
  const width = Math.max(20, columns - 4)

  // Everything below the transcript: whichever of the two footers is showing,
  // plus the status line under it. The thought is no longer a pane of its own
  // above the input — it is part of the transcript, so it costs nothing here.
  const footerRows = (permission ? PERMISSION_ROWS : COMPOSER_ROWS) + 2
  // A floor of 1, not 3: on a short viewport the old floor made the frame one
  // row taller than the screen, and the composer at the bottom is what it ate.
  const chatHeight = Math.max(1, rows - HEADER_ROWS - footerRows)

  const displayItems = useMemo<Item[]>(() => {
    const tail: Item[] = []
    // The thought sits under the question it belongs to, which is where it is
    // being written; the answer, once there is one, follows it.
    if (reasoning !== '') tail.push({ kind: 'reasoning', header: '', text: reasoning })
    if (live !== '') tail.push({ kind: 'assistant', text: live })
    return tail.length > 0 ? [...items, ...tail] : items
  }, [items, live, reasoning])
  const window = useMemo(
    () => visibleWindow(buildLines(displayItems, width), chatHeight, scrollOffset),
    [displayItems, width, chatHeight, scrollOffset],
  )
  const bodyLines = useMemo<Line[]>(() => {
    if (window.lines.length === 0 && !busy && displayItems.length === 0) {
      // Anchored like any other content: the first line of a session waits just
      // above the composer, not stranded at the top of an empty screen.
      return padToBottom([{ text: 'Ask Milo anything. Type /help for commands.', dim: true }], chatHeight)
    }
    return padToBottom(window.lines, chatHeight)
  }, [window.lines, chatHeight, busy, displayItems.length])

  const push = (item: Item) => setItems((current) => [...current, item])

  useInput((inputChar, key) => {
    if (permission) {
      // A tool is waiting on y/n, and the composer is not on screen.
      if (isCtrlC(inputChar, key)) resolvePermission(false)
      else if (inputChar === 'y' || inputChar === 'Y') resolvePermission(true)
      else if (inputChar === 'n' || inputChar === 'N' || key.escape) resolvePermission(false)
      return
    }
    if (isCtrlC(inputChar, key)) {
      if (runningRef.current) stop()
      else exit()
      return
    }
    if (key.return) {
      // Enter is taken here rather than by `TextInput`, which would only ever
      // see it as a return key: the modifier is what tells the two apart.
      void submit(input, isSteerKey(key)).catch((error) => push({ kind: 'error', text: errorMessage(error) }))
      return
    }
    if (key.meta && (key.upArrow || key.downArrow)) {
      // Alt+arrow is what a wheel tick is translated into before it reaches Ink
      // (see `../mouse.ts`): one line of transcript per tick. A bare arrow still
      // walks the input history, which is what the meta form leaves alone.
      const step = key.upArrow ? 1 : -1
      setScrollOffset((value) => Math.max(0, value + step))
      return
    }
    if (key.upArrow) recallHistory(-1)
    else if (key.downArrow) recallHistory(1)
    else if (key.pageUp) setScrollOffset((value) => value + Math.max(1, Math.floor(chatHeight / 2)))
    else if (key.pageDown) {
      setScrollOffset((value) => Math.max(0, value - Math.max(1, Math.floor(chatHeight / 2))))
    }
  })

  const runCommand = async (raw: string) => {
    const [command, ...rest] = raw.slice(1).trim().split(/\s+/)
    const argument = rest.join(' ')
    if (runningRef.current && BLOCKED_WHILE_BUSY.has(command)) {
      push({
        kind: 'info',
        text: `Can't /${command} while a turn is running — Ctrl+C to stop it first.`,
      })
      return
    }
    switch (command) {
      case 'model':
      case 'provider':
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
        // `brief`/`full` and `true`/`false` are older spellings of the same two
        // states: showing the reasoning, or not.
        const level =
          asked === 'off' || asked === 'false'
            ? 'off'
            : asked === 'on' || asked === 'true' || asked === 'brief' || asked === 'full'
              ? 'on'
              : undefined
        if (!level) {
          push({
            kind: 'info',
            text:
              `Thinking display: ${display.thinking}. This turns the showing of the reasoning on ` +
              'or off — the model thinks either way, and /effort is what changes that. ' +
              'Use /thinking on|off',
          })
          break
        }
        onDisplayChange({ thinking: level })
        push({
          kind: 'info',
          text:
            level === 'off'
              ? 'Thinking display: off. The model still reasons; this only stops showing it.'
              : 'Thinking display: on — the reasoning stays under the question.',
        })
        break
      }
      case 'effort': {
        const asked = argument.trim().toLowerCase()
        // `default`/`off` are older spellings of "back to Milo's own value",
        // which is medium.
        const next = (REASONING_EFFORTS as readonly string[]).includes(asked)
          ? (asked as ReasoningEffort)
          : asked === 'default' || asked === 'off'
            ? DEFAULT_REASONING_EFFORT
            : undefined
        if (!next) {
          push({
            kind: 'info',
            text:
              `Reasoning effort: ${runtime.reasoningEffort ?? DEFAULT_REASONING_EFFORT}. ` +
              'Use /effort low|medium|high',
          })
          break
        }
        onEffortChange(next)
        push({
          kind: 'info',
          text: `Reasoning effort: ${next} — affects how the model answers, and what it costs. Saved for every surface.`,
        })
        break
      }
      case 'new': {
        const session = await runtime.newSession(scope, argument || undefined)
        onSessionChange?.(session.id)
        // The size of a session is only known once a turn has been sent in it.
        setContextTokens(0)
        push({ kind: 'info', text: `New session: ${session.id}` })
        break
      }
      case 'sessions': {
        const outcome = buildSessionsList(await runtime.listSessions(), argument)
        push({ kind: 'info', text: outcome.ok ? outcome.result.reply : outcome.error })
        break
      }
      case 'skills':
        push({ kind: 'info', text: formatSkillList(runtime.skills) })
        break
      case 'memory': {
        const session = await runtime.getSession(scope)
        const asked = argument.trim()
        if (/^forget\b/i.test(asked)) {
          const id = asked.replace(/^forget\b/i, '').trim()
          if (!id) {
            push({ kind: 'info', text: 'Usage: /memory forget <id>. The ids come from /memory.' })
            break
          }
          push({
            kind: 'info',
            text: (await session.forget(id))
              ? `Forgotten: ${id} — it is out of recall from the next question on.`
              : `Nothing matches "${id}". Run /memory for the ids.`,
          })
          break
        }
        push({ kind: 'info', text: formatMemoryList(await session.memories(20)) })
        break
      }
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
        setContextTokens(0)
        push({ kind: 'info', text: `Switched to session ${session.id}.` })
        break
      }
      case 'fork': {
        const { targetId, upToTurn } = parseForkArgument(argument)
        const source = targetId ?? (await runtime.getSession(scope)).id
        const forked = await runtime.forkSession(scope, source, { upToTurn })
        if (!forked) {
          push({ kind: 'info', text: `No session "${source}". See /sessions for the ids.` })
          break
        }
        onSessionChange?.(forked.id)
        setContextTokens(0)
        push({ kind: 'info', text: `Branched into session ${forked.id}.` })
        break
      }
      case 'stats': {
        const session = await runtime.getSession(scope)
        push({ kind: 'fields', rows: statsRows(session.stats()) })
        break
      }
      case 'compact': {
        const session = await runtime.getSession(scope)
        push({ kind: 'info', text: compactReply(await session.compact()) })
        break
      }
      // The three that are about the turn rather than the session, carrying out
      // the same rules the bots do: `/stop` right now and without asking, and
      // `/steer` and `/queue` saying where a text goes.
      case 'stop':
      case 'steer':
      case 'queue': {
        const result = handleTurnControl(raw, {
          turn: controlTarget(),
          start: (pending) => submit(pending, false),
        })
        if (result.reply) push({ kind: 'info', text: result.reply })
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

  /** Files what has been streamed so far as a finished item. */
  const commitLive = () => {
    const text = liveRef.current
    liveRef.current = ''
    setLive('')
    if (text.trim()) push({ kind: 'assistant', text })
  }

  const runTurn = async (text: string, images: ImagePart[] = [], model?: string, audio: AudioPart[] = []) => {
    setScrollOffset(0)
    setLive('')
    liveRef.current = ''
    setReasoning('')
    setToolName('')
    setPhase('thinking')
    setStartedAt(Date.now())

    const controller = new AbortController()
    abortRef.current = controller
    // This turn's inbox. The surface writes into it, the loop empties it.
    const steering: string[] = []
    steeringRef.current = steering
    const startedAtMs = Date.now()
    // The compaction call happens before the turn's own, so its time is part of
    // the wait. Naming it is what stops the wait reading as the model being slow.
    let compactedMs = 0
    // Each wait is its own block: from the question to the model's first visible
    // output, then from the last tool result to the next one. Reasoning deltas do
    // not end it — they *are* the thinking; they are what fills the block.
    let waitingSince = startedAtMs
    let firstWait = true
    /** Whether anything arrived in the answer channel at all. */
    let answered = false
    /** Reasoning seen this turn, counted even when it is not kept. */
    let reasoningChars = 0
    /** Thinking too fast to be worth a line, kept in case it was the answer. */
    const dropped: string[] = []
    const stopWaiting = () => {
      const seconds = (Date.now() - waitingSince) / 1000
      waitingSince = Date.now()
      const thought = reasoningRef.current.trim()
      const compacting =
        firstWait && compactedMs > 0 ? ` (${formatSeconds(compactedMs / 1000)} compacting)` : ''
      firstWait = false
      reasoningRef.current = ''
      setReasoning('')
      // Under a second with nothing to account for there is nothing worth saying
      // — unless the thought is all the turn has said, which is only known at the
      // end. A summary call is never quiet, however fast the answer after it was.
      if (seconds < 1 && compacting === '') {
        if (thought) dropped.push(thought)
        return
      }
      const header = `✻ Thought for ${formatSeconds(seconds)}${compacting}`
      push({ kind: 'reasoning', header, text: thought })
    }

    try {
      const session = await runtime.getSession(scope)
      for await (const event of session.send(text, {
        signal: controller.signal,
        ask,
        steering,
        images,
        audio,
        ...(model ? { model } : {}),
      })) {
        applyEvent(event, {
          onText: (delta) => {
            stopWaiting()
            // Only text someone can read counts as an answer: a bare newline is
            // not one, and counting it switched off the rules that keep a turn's
            // thinking visible — leaving a ✻ line and nothing else on screen.
            if (delta.trim()) answered = true
            liveRef.current += delta
            setLive(liveRef.current)
            setPhase('writing')
          },
          onReasoning: (delta) => {
            // Counted whatever the level: a turn that says nothing in the answer
            // channel is worth explaining, and that is all that is left to go on.
            reasoningChars += delta.length
            // `off` keeps none of it: nothing is going to display it, and the
            // transcript has no use for it either.
            if (display.thinking === 'off') return
            reasoningRef.current += delta
            setReasoning(reasoningRef.current)
          },
          onToolStart: (name, args) => {
            toolArgsRef.current = args
            // A tool call with no prose before it is still the thinking ending.
            stopWaiting()
            // The step's text ends here. A turn's answer arrives one message per
            // step, and left as one blob the preamble before a tool call runs
            // straight into what follows it — "interage com a confirmação." +
            // "Não. Em yolo…" reads as one sentence. Filed now, the preamble
            // also lands above the tool line rather than after it, which is
            // where it was actually said.
            commitLive()
            // `off` keeps tool activity out of the transcript and out of the
            // status line, so the turn reads as plain thinking. A tool whose own
            // call is not drawn never reaches the status line either.
            if (display.tools === 'off' || !showsToolCall(name)) return
            setToolName(name)
            setPhase('tool')
          },
          onToolEnd: (name, isError) => {
            // A failure is always shown, even with tools off.
            if ((display.tools !== 'off' && showsToolCall(name)) || isError) {
              push({
                kind: 'tool',
                name,
                detail: display.tools === 'name' ? '' : toolDetail(toolArgsRef.current),
                ok: !isError,
              })
            }
            setToolName('')
            setPhase('thinking')
            // The next wait starts when the tool is done, not when it was asked
            // for: running the tool is not the model thinking.
            waitingSince = Date.now()
          },
          // The plan is drawn as its own block, not a tool line, so it appears
          // whatever the tool level is set to — the person watching a long turn
          // wants to see it either way.
          onTodo: (items) => push({ kind: 'todo', items }),
          onUsage: (inputTokens) => setContextTokens(inputTokens),
          onCompacted: (ms) => {
            compactedMs = ms
          },
          // The status line carries the wait while it lasts; the transcript gets
          // it once it is over, with what it actually cost.
          onWaiting: () => setPhase('waiting'),
          onWaited: (ms) => {
            waitingSince = Date.now()
            setPhase('thinking')
            push({ kind: 'info', text: `⏳ waited ${formatSeconds(ms / 1000)} for another Milo.` })
          },
          onRebased: (event) => {
            push({ kind: 'info', text: `↺ another Milo has used this session: ${describeRebase(event)}.` })
          },
          onDone: (finishReason) => {
            // A capped answer otherwise looks like a complete one.
            if (finishReason === 'length') {
              push({
                kind: 'info',
                text: '⚠ hit the output limit — the answer was cut off. Raise "maxTokens" in config.yml.',
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

    // A correction the model never got to see is not dropped: it becomes the
    // next turn, in the order it was typed. After Ctrl+C there is nothing here
    // — the mailbox was emptied on purpose.
    if (steering.length > 0) {
      queueRef.current.push(...steering.map((text) => ({ text, images: [], audio: [] })))
      setQueued(queueRef.current.length)
    }

    // Reasoning that nothing followed: no line under it, no tool after it. That
    // is not a thought on the way to an answer, it is what the model said — one
    // that answers in the thinking channel says everything there — so it is
    // kept. What the earlier waits said but never reported rides along, before
    // it, so a turn keeps its own order. Dropping any of this made a turn look
    // like it produced nothing, moments after the text had scrolled past the
    // screen.
    const trailing = [...dropped, reasoningRef.current.trim()].filter(Boolean)
    if (trailing.length > 0) {
      const seconds = (Date.now() - waitingSince) / 1000
      push({
        kind: 'reasoning',
        // Same rule as any other wait: under a second there is nothing to say.
        header: seconds < 1 ? '' : `✻ Thought for ${formatSeconds(seconds)}`,
        text: trailing.join('\n\n'),
      })
      reasoningRef.current = ''
      setReasoning('')
    }

    // Nothing came back in the answer channel, and the display hid what did: a turn
    // that shows a user nothing at all has to at least say why, or the provider
    // putting both channels in one field looks like Milo having gone quiet.
    if (!answered && reasoningChars > 0 && display.thinking === 'off') {
      push({
        kind: 'info',
        text:
          '⚠ no answer came back: this model sends everything it says as reasoning, and ' +
          '/thinking off hides it. MILO_DEBUG=1 prints what the wire carried.',
      })
    }

    commitLive()
    setReasoning('')
    setToolName('')
    setPermission(null)
    setLastDuration((Date.now() - startedAtMs) / 1000)
    steeringRef.current = null
    abortRef.current = null
  }

  /**
   * Runs the queued messages one turn at a time. The turn state stays open
   * across them, so a message typed during a turn reads as part of the same
   * stretch of work rather than as an unrelated turn.
   */
  const pump = () => {
    if (runningRef.current) return
    runningRef.current = true
    void (async () => {
      try {
        while (queueRef.current.length > 0) {
          const queued = queueRef.current.shift() as { text: string; images: ImagePart[]; audio: AudioPart[]; model?: string }
          setQueued(queueRef.current.length)
          try {
            await runTurn(queued.text, queued.images, queued.model, queued.audio)
          } catch (error) {
            // A turn that blows up must not take the rest of the queue with it.
            push({ kind: 'error', text: errorMessage(error) })
          }
        }
      } finally {
        runningRef.current = false
        steeringRef.current = null
        setPhase('idle')
        setQueued(queueRef.current.length)
        const dropped = droppedRef.current
        droppedRef.current = 0
        if (dropped > 0) {
          push({
            kind: 'info',
            text: `${dropped} queued message${dropped === 1 ? '' : 's'} dropped.`,
          })
        }
      }
    })()
  }

  /** Ctrl+C during a turn: stop it, and drop whatever was waiting behind it. */
  const stop = () => {
    droppedRef.current = queueRef.current.length + (steeringRef.current?.length ?? 0)
    queueRef.current = []
    // Emptied in place, not reassigned: the running turn holds this very array,
    // and anything left in it would be run as the next turn.
    steeringRef.current?.splice(0)
    setQueued(0)
    abortRef.current?.abort()
  }

  /**
   * The turn running now, as the shared control commands see it. The terminal
   * has its own machinery — an inbox ref for the turn, a queue ref for what waits
   * behind it, an `AbortController` to stop it — and this is where the shared
   * vocabulary meets it: the answers and the rules come from the same place the
   * bots use, only the plumbing is local.
   */
  const controlTarget = (): TurnControlTarget => ({
    steer: (text) => {
      const inbox = steeringRef.current
      if (!inbox) return false
      inbox.push(text)
      return true
    },
    // The inbox is the authority, not `runningRef`: the pump stays running across
    // the gaps between turns, and a command typed in a gap has no turn to join.
    busy: () => steeringRef.current !== null,
    queued: () => queueRef.current.length,
    stop: () => {
      const stopped = steeringRef.current !== null
      const dropped = queueRef.current.length + (steeringRef.current?.length ?? 0)
      // The same stop Ctrl+C runs, down to the dropped count it reports when the
      // turn is over — `/stop` and Ctrl+C must not differ in what they throw away.
      stop()
      return { stopped, dropped }
    },
  })

  /** Records a line that was sent, and puts the arrows back at the live end. */
  const remember = (text: string) => {
    const history = inputHistoryRef.current
    // The same line twice in a row is one entry: recalling it twice is noise.
    if (history[history.length - 1] !== text) history.push(text)
    if (history.length > HISTORY_LIMIT) history.shift()
    historyIndexRef.current = null
    draftRef.current = ''
    void saveInputHistory(history)
  }

  /**
   * Up walks back through what was sent, Down walks forward again — and past
   * the newest line it hands back whatever was being typed when the walk
   * started, so reaching for an old line never costs the one in the composer.
   */
  const recallHistory = (direction: -1 | 1) => {
    const history = inputHistoryRef.current
    if (history.length === 0) return
    const current = historyIndexRef.current
    if (current === null) {
      if (direction === 1) return
      draftRef.current = input
    }
    const next = current === null ? history.length - 1 : current + direction
    if (next < 0) return
    // A fresh mount is what puts the cursor at the end of the recalled line,
    // where the next keystroke belongs; the input keeps its old offset otherwise.
    setRecallEpoch((epoch) => epoch + 1)
    if (next >= history.length) {
      historyIndexRef.current = null
      setInput(draftRef.current)
      return
    }
    historyIndexRef.current = next
    setInput(history[next] as string)
  }

  /**
   * Enter sends — or queues, when a turn is already running. Ctrl+Enter steers:
   * the message joins the turn in flight instead of waiting for it.
   */
  const submit = async (raw: string, steer: boolean) => {
    const rawText = raw.trim()
    const fileTokens = [...rawText.matchAll(/(?:^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g)]
      .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
      .filter(Boolean)
    const text = rawText.replace(/(?:^|\s)@(?:"[^"]+"|'[^']+'|[^\s]+)/g, ' ').trim()
    if (!text && fileTokens.length === 0) return
    let images: ImagePart[] = []
    let audio: AudioPart[] = []
    let attachedText: string[] = []
    let mediaModel: string | undefined
    try {
      if (fileTokens.length) {
        const files = await Promise.all(fileTokens.map(async (file) => {
          const bytes = await readFile(path.resolve(file))
          const ext = path.extname(file).toLowerCase()
          const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain', '.md': 'text/markdown' } as Record<string, string>)[ext] ?? 'application/octet-stream'
          return { name: path.basename(file), mimeType, data: bytes }
        }))
        const prepared = await prepareIncoming(files, { model: runtime.model })
        images = prepared.images
        audio = prepared.audio
        attachedText = prepared.text
        mediaModel = prepared.model
      }
    } catch (error) {
      push({ kind: 'error', text: `Could not read attachment: ${errorMessage(error)}` })
      return
    }
    const prompt = [text, ...attachedText].filter(Boolean).join('\n\n') || 'Please inspect the attached media.'
    setInput('')
    remember(rawText)

    // Whatever was typed lands in the transcript, commands included: it is one
    // line of the conversation being read back, and a command that left no
    // trace read as if it had never been sent. Filing the answer still
    // streaming first is what keeps the order.
    commitLive()
    push({ kind: 'user', text: prompt })
    setScrollOffset(0)

    // A command that throws must not become an unhandled rejection: say what
    // broke instead of appearing to ignore the line.
    if (text.startsWith('/')) {
      if (fileTokens.length) {
        push({ kind: 'error', text: 'Send files with a message, not with a command.' })
        return
      }
      void runCommand(text).catch((error) => push({ kind: 'error', text: errorMessage(error) }))
      return
    }

    const steering = steeringRef.current
    if (steer && steering && images.length === 0) {
      steering.push(prompt)
      return
    }
    queueRef.current.push({ text: prompt, images, audio, ...(mediaModel ? { model: mediaModel } : {}) })
    setQueued(queueRef.current.length)
    pump()
  }

  const statusLabel =
    phase === 'asking'
      ? 'waiting for confirmation'
      : phase === 'waiting'
        ? 'waiting for another Milo on this session…'
        : phase === 'tool'
          ? `${toolName}…`
          : phase === 'writing'
            ? 'writing…'
            : 'thinking…'

  const statusText = `${statusLabel} ${formatSeconds(elapsed)}${queued > 0 ? ` · ${queued} queued` : ''}`
  const scrolled = window.offset > 0 ? `▲ scrolled (${window.offset})` : ''
  const idleText = scrolled || 'Ready'
  const counters = [
    !busy && lastDuration !== null ? `last ${formatSeconds(lastDuration)}` : '',
    contextTokens > 0 ? `${formatTokens(contextTokens)} tok` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  // One band under the composer: what the request runs on, and where it is going,
  // said once. Each field is a muted label and a value that carries the colour, so
  // the eye lands on what is set rather than on the word naming it. The model's own
  // name already says where the request goes, so the provider is not repeated; a
  // flag that takes something away wears the warning tone; and the fields drop from
  // the end when the line does not fit, the session id first — the state that takes
  // something away outlives the id nobody has to read twice.
  const footerParts: FooterPart[] = [
    ...(model
      ? [
          { text: model.model, color: theme.accent, bold: true },
          { label: 'effort', text: model.effort, color: theme.secondary },
        ]
      : [{ text: 'Milo', color: theme.muted }]),
    ...(mode !== 'ask' ? [{ text: PERMISSION_LABELS[mode], color: theme.warning }] : []),
    ...(display.tools !== 'full' ? [{ label: 'tools', text: display.tools, color: theme.warning }] : []),
    ...(display.thinking === 'off' ? [{ label: 'thinking', text: 'hidden', color: theme.warning }] : []),
    ...(sessionId ? [{ label: 'session', text: sessionId, color: theme.muted }] : []),
  ]
  const footerWidth = Math.max(1, columns - 4)
  const partWidth = (part: FooterPart) => (part.label ? part.label.length + 1 : 0) + part.text.length
  const footerWidthOf = (parts: FooterPart[]) =>
    parts.reduce((total, part, index) => total + partWidth(part) + (index > 0 ? 3 : 0), 0)
  while (footerWidthOf(footerParts) > footerWidth && footerParts.length > 1) footerParts.pop()
  if (footerWidthOf(footerParts) > footerWidth) {
    const last = footerParts[footerParts.length - 1]
    if (last) {
      const label = last.label ? last.label.length + 1 : 0
      last.text = `${last.text.slice(0, Math.max(1, footerWidth - label - 1))}…`
    }
  }
  const statusWidth = (busy ? statusText.length + 2 : idleText.length + 2)
  const showCounters = counters !== '' && statusWidth + counters.length <= columns - 4

  return (
    <Box flexDirection="column" height={rows - HEADER_ROWS} width={columns}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {bodyLines.map((line, index) => (
          // Every line is its own row box, inset where the transcript is; a line
          // carrying a background fills the whole row, the way the composer does,
          // and the ones without one are transparent and read as plain text.
          // biome-ignore lint/suspicious/noArrayIndexKey: the window is rebuilt every frame and never reorders
          <Box key={index} width={columns} paddingX={2} backgroundColor={line.background}>
            <Text color={line.color} dimColor={line.dim}>
              {line.segments
                ? line.segments.map((segment, segmentIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments are re-wrapped every frame and never reorder
                    <Text key={segmentIndex} bold={segment.bold} color={segment.color}>
                      {segment.text}
                    </Text>
                  ))
                : line.text || ' '}
            </Text>
          </Box>
        ))}
      </Box>

      <Box paddingX={2} width={columns} justifyContent="space-between">
        {busy ? (
          <Text color={theme.warning}>
            <Spinner type="dots" /> {statusText}
          </Text>
        ) : (
          <Text color={theme.muted}>{idleText}</Text>
        )}
        {showCounters ? <Text color={theme.muted}>{counters}</Text> : null}
      </Box>

      {permission ? (
        <Box flexDirection="column" paddingX={2}>
          <Text color={theme.warning}>⚠ Milo wants to run {toolDisplayName(permission.tool)}:</Text>
          <Text color={theme.warning}>  {permission.summary}</Text>
          <Text color={theme.muted}>[y] allow · [n] deny</Text>
        </Box>
      ) : (
        <Box
          backgroundColor={theme.surface}
          paddingX={2}
          width={columns}
          height={COMPOSER_ROWS}
          alignItems="center"
          overflow="hidden"
        >
          <Text bold>› </Text>
          {/* Always mounted, and without an `onSubmit`: a turn running is no
              reason to take the composer away — it is exactly when a correction
              is worth typing — and Enter is read one level up, where the
              modifier that tells queue and steer apart is still visible. The
              placeholder is drawn here rather than by the input, whose own hint
              is grey — and a grey that vanishes against the composer's fill is
              no hint at all. */}
          <TextInput key={recallEpoch} value={input} onChange={setInput} placeholder="" />
          {input === '' && (
            <Text color={theme.surfaceText}>
              {' '}
              {busy ? 'Queue a message — Ctrl+Enter to steer…' : 'Type a message or @file…'}
            </Text>
          )}
        </Box>
      )}

      <Box paddingX={2} width={columns}>
        {footerParts.map((part, index) => (
          <Text key={`${part.label ?? ''}:${part.text}`}>
            {index > 0 ? <Text color={theme.muted}> · </Text> : null}
            {part.label ? <Text color={theme.muted}>{part.label} </Text> : null}
            <Text color={part.color} bold={part.bold}>
              {part.text}
            </Text>
          </Text>
        ))}
      </Box>
    </Box>
  )
}

interface EventHandlers {
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
  onToolStart: (name: string, args: unknown) => void
  onToolEnd: (name: string, isError: boolean) => void
  /** The plan the model is keeping, in full, each time it changes. */
  onTodo: (items: TodoItem[]) => void
  /** What the last request cost in input tokens: the size of the session as sent. */
  onUsage: (inputTokens: number) => void
  /** How long the compaction's own model call took, in ms. */
  onCompacted: (ms: number) => void
  /** Another Milo holds this session; the turn has not started yet. */
  onWaiting: () => void
  /** The wait is over, and how long it was. The turn starts here. */
  onWaited: (ms: number) => void
  /** The session was not as this copy had it: turns arrived, or went, elsewhere. */
  onRebased: (event: { added: number; removed: number; compacted: boolean }) => void
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
    case 'todo':
      handlers.onTodo(event.items)
      break
    case 'usage':
      handlers.onUsage(event.inputTokens)
      break
    case 'compacted':
      handlers.onCompacted(event.ms)
      break
    case 'waiting':
      handlers.onWaiting()
      break
    case 'waited':
      handlers.onWaited(event.ms)
      break
    case 'rebased':
      handlers.onRebased(event)
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
  if (value < 1000) return String(value)
  const thousands = value / 1000
  // A tenth is worth showing at 8.3k; at 22.0k it is noise. Rounding to one
  // decimal first is what drops the trailing zero.
  const rounded = thousands < 10 ? Math.round(thousands * 10) / 10 : Math.round(thousands)
  return `${rounded}k`
}

/** `1 turn`, `2 turns` — "1 turns" is the kind of thing that makes a block look unfinished. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

/** A tenth of a second matters at 6.4s; at 51s it is noise. */
function formatSeconds(value: number): string {
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}s`
}

/**
 * `/stats`, as rows. The token lines matter because the oldest turns are
 * summarized away once the context passes the budget, so the budget is what
 * turns a token count into something worth reading. Whatever the session does
 * not have — no prompt measured yet, no compaction — is left out rather than
 * shown as a zero.
 */
function statsRows(stats: SessionStats): { label: string; value: string }[] {
  const used = stats.tokens + (stats.fixedTokens ?? 0)
  const budget = stats.maxInputTokens ? ` of ${formatTokens(stats.maxInputTokens)}` : ''
  const rows = [
    { label: 'session', value: stats.title ? `${stats.id} — ${stats.title}` : stats.id },
    {
      label: 'started',
      value: `${formatWhen(stats.createdAt)} · last turn ${formatWhen(stats.updatedAt)}`,
    },
    {
      label: 'context',
      value:
        `${count(stats.messages, 'message')} · ${count(stats.turns, 'turn')} · ` +
        `~${formatTokens(used)}${budget} tokens`,
    },
  ]
  if (stats.compacted) {
    rows.push({
      label: 'compacted',
      value: stats.droppedTokens
        ? `~${formatTokens(stats.droppedTokens)} tokens summarized`
        : 'yes',
    })
  }
  return rows
}
