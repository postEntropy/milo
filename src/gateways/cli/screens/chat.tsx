import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Box, Text, useApp, useInput } from 'ink'
import Spinner from 'ink-spinner'
import type { AgentEvent } from '../../../core/agent/events.js'
import { listProviderModels, listProviders, setProvider } from '../../../core/config/load.js'
import type { DisplayConfig } from '../../../core/config/schema.js'
import type { MemoryScope } from '../../../core/memory/index.js'
import { byRecentUse, projectNames, readProjects } from '../../../core/projects.js'
import type {
  AudioPart,
  DocumentPart,
  ImagePart,
  Message,
  ReasoningEffort,
} from '../../../core/providers/types.js'
import type { AgentRuntime } from '../../../core/runtime.js'
import { MAX_INCOMING_BYTES, MAX_INCOMING_TOTAL_BYTES } from '../../../core/media.js'
import { prepareTurnMedia } from '../../media.js'
import {
  describeRebase,
  formatSeconds,
  type SessionStats,
  type SessionSummary,
} from '../../../core/sessions/index.js'
import { formatWhen } from '../../../core/time.js'
import type { TodoItem } from '../../../core/todos.js'
import {
  PERMISSION_LABELS,
  type PermissionAsker,
  type PermissionMode,
  type PermissionPolicy,
  type PermissionRequest,
  type PermissionResult,
} from '../../../core/tools/permission.js'
import { resolveToolPath, walk } from '../../../core/tools/walk.js'
import type { FileChange } from '../../../core/change.js'
import type { GenUiRender } from '../../../core/genui.js'
import type { PanelRequest } from '../../../core/panel.js'
import { errorMessage } from '../../../util/errors.js'
import { formatTokens } from '../../../util/format.js'
import { COMMAND_CATALOG } from '../../command-catalog.js'
import {
  compactReply,
  handleCommand,
  handleTurnControl,
  type CommandContext,
  type TurnControlTarget,
} from '../../commands.js'
import { changeCounts, showsToolCall, toolDetail, toolDisplayName } from '../../tool-line.js'
import { copyToClipboard, setMouseTracking } from '../ansi.js'
import { Composer, truncateLine, wrapComposerLines } from '../components/composer.js'
import { FolderPicker, type RecentFolder } from '../components/folder-picker.js'
import { miloMarkRows } from '../components/milo-mark.js'
import { SessionPicker } from '../components/session-picker.js'
import { describePanelRequest, itemsFromMessages, summarizeGenUi } from '../history-items.js'
import { readInputHistory, saveInputHistory } from '../input-history.js'
import { isCopyKey, isCtrlC, isExpandToolKey, isMouseToggleKey } from '../keys.js'
import { theme as defaultTheme, type ThemeColor, type TuiTheme } from '../theme.js'
import { buildLines, padToBottom, visibleWindow, type Item, type Line, type LineSegment } from '../transcript.js'
import { useElapsed } from '../use-elapsed.js'
import { useTerminalSize } from '../use-terminal-size.js'

type Phase = 'idle' | 'thinking' | 'writing' | 'tool' | 'asking' | 'waiting' | 'compacting'

const HEADER_ROWS = 0
/** The permission prompt: the question and the key it is waiting on. */
const PERMISSION_ROWS = 3
/** Interval in ms used to coalesce streaming text and reasoning deltas. */
const STREAM_FLUSH_MS = 24
/** How long file completion suggestions are cached per root directory. */
const FILE_CACHE_TTL_MS = 5000
/** Duration in ms for transient footer/status notices. */
const FLASH_NOTICE_MS = 2500

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
  /** Working directory fallback used for file completions and relative attachments. */
  cwd?: string
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
  /** Active working folder for the current session, or null for the default directory. */
  sessionFolder?: string | null
  onSessionFolderChange?: (folder: string | null) => void
  /** Active backend identifier for the current session (e.g. 'milo' or 'command-code'). */
  sessionBackend?: string
  onSessionBackendChange?: (backend: string) => void
  /** Model context budget for the active session, when known. */
  maxInputTokens?: number
  onMaxInputTokensChange?: (tokens: number | undefined) => void
  /** Whether terminal mouse tracking has been toggled off via Ctrl+M. */
  mouseOff?: boolean
  onMouseOffChange?: (off: boolean) => void
  /** Called when /provider or /model updates config on disk so the shell reloads. */
  onConfigRefresh?: () => void
  /** Resolved TUI color theme. */
  theme?: TuiTheme
  /** Fired when /new or /resume rebinds this conversation to another session. */
  onSessionChange?: (id: string) => void
  /** A finished job's announcement is running: its id, drawn in the status line. */
  jobNotice?: string | null
}

/**
 * The commands a running turn rules out. They rebind the session, empty the
 * transcript it is writing into, or take over the screen its output goes to —
 * so they would fight the turn rather than wait behind it.
 */
const BLOCKED_WHILE_BUSY = new Set([
  'new',
  'resume',
  'fork',
  'clear',
  'model',
  'provider',
  'setup',
  'compact',
  'folder',
])

/**
 * How many sent lines the arrows walk back through. Kept in memory, for this
 * run: enough to get back to anything said in a sitting, and nothing left on
 * disk to explain afterwards.
 */
const HISTORY_LIMIT = 200

export function ChatScreen({
  runtime,
  scope,
  cwd,
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
  onSessionFolderChange,
  onSessionBackendChange,
  onMaxInputTokensChange,
  onConfigRefresh,
  theme: themeProp,
  model,
  sessionId,
  sessionFolder,
  sessionBackend,
  maxInputTokens,
  mouseOff: mouseOffProp,
  onMouseOffChange,
  jobNotice,
}: ChatScreenProps) {
  const activeTheme = themeProp ?? defaultTheme
  const baseCwd = cwd ?? process.cwd()
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
  /** How many background jobs are running, for the status line's counter. */
  const [runningJobs, setRunningJobs] = useState(0)
  /** Active overlay picker replacing the composer when open. */
  const [activePicker, setActivePicker] = useState<'sessions' | 'folder' | null>(null)
  const [pickerSessions, setPickerSessions] = useState<SessionSummary[]>([])
  const [pickerProjects, setPickerProjects] = useState<Record<string, string>>({})
  const [pickerRecentFolders, setPickerRecentFolders] = useState<RecentFolder[]>([])
  /** Rows currently occupied by the composer's `/` or `@` completion popup. */
  const [popupRows, setPopupRows] = useState(0)
  /** Transient confirmation/notice in the status line (e.g. copy or mouse toggle). */
  const [flashNotice, setFlashNotice] = useState<string | null>(null)
  /** Whether mouse tracking was explicitly disabled via Ctrl+M for text selection. */
  const [localMouseOff, setLocalMouseOff] = useState(mouseOffProp ?? false)
  const [localFolder, setLocalFolder] = useState<string | null>(sessionFolder ?? null)
  const [localBackend, setLocalBackend] = useState<string>(sessionBackend ?? 'milo')
  const [localMaxTokens, setLocalMaxTokens] = useState<number | undefined>(maxInputTokens)

  useEffect(() => {
    if (mouseOffProp !== undefined) setLocalMouseOff(mouseOffProp)
  }, [mouseOffProp])

  useEffect(() => {
    if (sessionFolder !== undefined) setLocalFolder(sessionFolder)
  }, [sessionFolder])

  useEffect(() => {
    if (sessionBackend !== undefined) setLocalBackend(sessionBackend)
  }, [sessionBackend])

  useEffect(() => {
    if (maxInputTokens !== undefined) setLocalMaxTokens(maxInputTokens)
  }, [maxInputTokens])

  const mouseOff = mouseOffProp !== undefined ? mouseOffProp : localMouseOff
  const activeFolder = sessionFolder !== undefined ? sessionFolder : localFolder
  const activeBackend = sessionBackend !== undefined ? sessionBackend : localBackend
  const budgetTokens = maxInputTokens !== undefined ? maxInputTokens : localMaxTokens

  const updateMouseOff = useCallback(
    (next: boolean) => {
      setLocalMouseOff(next)
      onMouseOffChange?.(next)
    },
    [onMouseOffChange],
  )

  const updateFolder = useCallback(
    (next: string | null) => {
      setLocalFolder(next)
      onSessionFolderChange?.(next)
    },
    [onSessionFolderChange],
  )

  const updateBackend = useCallback(
    (next: string) => {
      setLocalBackend(next)
      onSessionBackendChange?.(next)
    },
    [onSessionBackendChange],
  )

  const updateMaxTokens = useCallback(
    (next: number | undefined) => {
      setLocalMaxTokens(next)
      onMaxInputTokensChange?.(next)
    },
    [onMaxInputTokensChange],
  )

  // The manager changes under the UI — a job started a moment ago by a tool call,
  // one that just ended — so the count is read live rather than threaded down. Only
  // this session's: another conversation's work is not this terminal's.
  useEffect(() => {
    const jobs = runtime.jobs
    if (!jobs) return
    const sync = () => setRunningJobs(jobs.list(sessionId ?? undefined).filter((job) => job.state === 'running').length)
    sync()
    return jobs.onChange(sync)
  }, [runtime, sessionId])

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
  /** Timer used to batch streaming text/reasoning deltas into fewer Ink redraws. */
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Tracks whether a streaming draft `ui` item is on screen and should be replaced. */
  const draftUiActiveRef = useRef(false)
  /** Messages typed behind the turn in flight, in the order they were typed. */
  const queueRef = useRef<Array<{ text: string; images: ImagePart[]; audio: AudioPart[]; documents?: DocumentPart[]; imagesForDisplayOnly?: boolean; displayText?: string; mediaNotices?: string[]; model?: string }>>([])
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
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileCacheRef = useRef<{ root: string; entries: string[]; loadedAt: number } | null>(null)
  const maxOffsetRef = useRef(0)

  const showFlash = useCallback((notice: string) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    setFlashNotice(notice)
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null
      setFlashNotice(null)
    }, FLASH_NOTICE_MS)
  }, [])

  const flushStream = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    setLive(liveRef.current)
    setReasoning(reasoningRef.current)
  }, [])

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      setLive(liveRef.current)
      setReasoning(reasoningRef.current)
    }, STREAM_FLUSH_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    }
  }, [])

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

  const resolvePermission = (allowed: boolean, remember = false) => {
    const resolve = permissionResolverRef.current
    permissionResolverRef.current = null
    setPermission(null)
    setPhase('thinking')
    resolve?.({ allowed, ...(remember ? { remember } : {}) })
  }

  const folderLabel = activeFolder ? path.basename(activeFolder) || activeFolder : null

  // Dynamically size the composer/picker/footer so total rows never exceed `rows`.
  const maxComposerLines = Math.max(1, Math.min(6, rows - 5))
  const composerTextWidth = Math.max(1, columns - 7)
  const composerVisualCount = input === '' ? 1 : wrapComposerLines(input, composerTextWidth).length
  const composerLines = Math.min(maxComposerLines, Math.max(1, composerVisualCount))
  const composerRows = composerLines + 2
  const maxPopupRows = Math.max(0, Math.min(6, rows - composerRows - 3))
  const activePopupRows = Math.min(popupRows, maxPopupRows)
  const pickerHeight = Math.max(4, Math.min(12, rows - 4))

  // Everything below the transcript: whichever footer mode is active, plus the
  // status line above it and the metadata band under it.
  const footerRows =
    (activePicker
      ? pickerHeight
      : permission
        ? PERMISSION_ROWS
        : composerRows + activePopupRows) + 2
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

  // The width the transcript wraps to: the screen less the two columns each line
  // is inset by (and two more when a scrollbar sits on the right edge), so a
  // line never runs past the edge and gets clipped.
  const baseWidth = Math.max(8, columns - 4)
  const initialLines = useMemo(
    () => buildLines(displayItems, baseWidth, activeTheme),
    [displayItems, baseWidth, activeTheme],
  )
  const scrollable = initialLines.length > chatHeight
  const width = scrollable ? Math.max(8, columns - 6) : baseWidth
  const allLines = useMemo(
    () => (scrollable ? buildLines(displayItems, width, activeTheme) : initialLines),
    [scrollable, initialLines, displayItems, width, activeTheme],
  )
  const window = useMemo(
    () => visibleWindow(allLines, chatHeight, scrollOffset),
    [allLines, chatHeight, scrollOffset],
  )
  maxOffsetRef.current = window.maxOffset
  const bodyLines = useMemo<Line[]>(() => {
    if (window.lines.length === 0 && !busy && displayItems.length === 0) {
      // Anchored like any other content: the empty-state hero waits just above
      // the composer, not stranded at the top of an empty screen.
      return padToBottom(
        emptyHeroLines({
          chatHeight,
          columns,
          width: baseWidth,
          activeTheme,
          modelName: model?.model,
          folderLabel,
        }),
        chatHeight,
      )
    }
    return padToBottom(window.lines, chatHeight)
  }, [
    window.lines,
    chatHeight,
    busy,
    displayItems.length,
    columns,
    baseWidth,
    activeTheme,
    model?.model,
    folderLabel,
  ])

  const push = (item: Item) => setItems((current) => [...current, item])

  const scrollBy = useCallback((delta: number) => {
    setScrollOffset((value) => Math.max(0, Math.min(maxOffsetRef.current, value + delta)))
  }, [])

  const suggestFiles = useCallback(
    async (query: string): Promise<string[]> => {
      const root = activeFolder ?? baseCwd
      const now = Date.now()
      let entries =
        fileCacheRef.current?.root === root && now - fileCacheRef.current.loadedAt < FILE_CACHE_TTL_MS
          ? fileCacheRef.current.entries
          : null
      if (!entries) {
        const walked = await walk({ root, maxEntries: 1500 })
        entries = walked.entries.map((entry) => entry.rel)
        fileCacheRef.current = { root, entries, loadedAt: now }
      }
      const lower = query.toLowerCase()
      if (!lower) return entries.slice(0, 6)
      const prefix: string[] = []
      const contains: string[] = []
      for (const rel of entries) {
        const lowerRel = rel.toLowerCase()
        if (lowerRel.startsWith(lower) || path.basename(lowerRel).startsWith(lower)) prefix.push(rel)
        else if (lowerRel.includes(lower)) contains.push(rel)
      }
      return [...prefix, ...contains].slice(0, 6)
    },
    [activeFolder, baseCwd],
  )

  const toggleExpandTools = () => {
    let lastUser = -1
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]?.kind === 'user') {
        lastUser = i
        break
      }
    }
    const turnIndexes: number[] = []
    let fallbackIndex = -1
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (items[i]?.kind === 'tool') {
        if (fallbackIndex === -1) fallbackIndex = i
        if (i > lastUser) turnIndexes.push(i)
      }
    }
    const targets = turnIndexes.length > 0 ? turnIndexes : fallbackIndex !== -1 ? [fallbackIndex] : []
    if (targets.length === 0) {
      showFlash('No tool calls to expand')
      return
    }
    const targetSet = new Set(targets)
    const nextExpanded = targets.some((idx) => {
      const item = items[idx]
      return item?.kind === 'tool' && !item.expanded
    })
    showFlash(nextExpanded ? 'Expanded tool details' : 'Collapsed tool details')
    setItems((current) =>
      current.map((item, idx) =>
        item.kind === 'tool' && targetSet.has(idx) ? { ...item, expanded: nextExpanded } : item,
      ),
    )
  }

  const copyLastReply = () => {
    if (liveRef.current.trim()) {
      copyToClipboard(liveRef.current)
      showFlash('Copied reply')
      return
    }
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]
      if (item?.kind === 'assistant' && item.text.trim()) {
        copyToClipboard(item.text)
        showFlash('Copied last reply')
        return
      }
      if (item?.kind === 'tool' && item.result?.trim()) {
        copyToClipboard(item.result)
        showFlash('Copied tool output')
        return
      }
    }
    showFlash('Nothing to copy')
  }

  const openSessionPicker = async () => {
    if (runningRef.current) {
      showFlash("Can't switch sessions while a turn is running")
      return
    }
    if (!runtime.listSessions) {
      push({ kind: 'info', text: 'Session switching is not available on this surface.' })
      return
    }
    try {
      const [sessions, names] = await Promise.all([runtime.listSessions(), Promise.resolve(projectNames())])
      setPickerSessions(sessions)
      setPickerProjects(Object.fromEntries(names))
      setActivePicker('sessions')
    } catch (error) {
      push({ kind: 'error', text: errorMessage(error) })
    }
  }

  const openFolderPicker = async () => {
    if (runningRef.current) {
      showFlash("Can't change folder while a turn is running")
      return
    }
    try {
      const sessions = runtime.listSessions ? await runtime.listSessions() : []
      const projects = readProjects()
      const ordered = byRecentUse(projects, sessions)
      setPickerRecentFolders(ordered.map((project) => ({ id: project.id, name: project.name, path: project.path })))
      setActivePicker('folder')
    } catch (error) {
      push({ kind: 'error', text: errorMessage(error) })
    }
  }

  useInput(
    (inputChar, key) => {
      if (key.eventType === 'release') return
      if (permission) {
        // A tool is waiting on y/n, and the composer is not on screen.
        if (isCtrlC(inputChar, key)) resolvePermission(false)
        else if (inputChar === 'y' || inputChar === 'Y') resolvePermission(true)
        else if ((inputChar === 'a' || inputChar === 'A') && permission.approvalScope) resolvePermission(true, true)
        else if (inputChar === 'n' || inputChar === 'N' || key.escape) resolvePermission(false)
        return
      }
      if (isCtrlC(inputChar, key)) {
        if (runningRef.current) stop()
        else exit()
        return
      }
      if (isExpandToolKey(inputChar, key)) {
        toggleExpandTools()
        return
      }
      if (isCopyKey(inputChar, key)) {
        copyLastReply()
        return
      }
      if (isMouseToggleKey(inputChar, key)) {
        const nextOff = !mouseOff
        setMouseTracking(!nextOff)
        updateMouseOff(nextOff)
        showFlash(nextOff ? 'Mouse off — drag to select text' : 'Mouse scroll enabled')
        return
      }
      if (key.ctrl && inputChar === 's') {
        void openSessionPicker()
        return
      }
      if (key.end || (key.escape && window.offset > 0)) {
        setScrollOffset(0)
        return
      }
      if (key.pageUp) scrollBy(Math.max(1, Math.floor(chatHeight / 2)))
      else if (key.pageDown) scrollBy(-Math.max(1, Math.floor(chatHeight / 2)))
    },
    { isActive: !activePicker },
  )

  const applySwitchedSession = async (
    nextSession: {
      id: string
      messages?: Message[]
      project?: { ok: true; project: { path: string } } | { ok: false; error: string }
      backend?: { kind: string }
      stats?: () => SessionStats
      refreshHistory?: () => Promise<Message[]>
    },
    hydrate: boolean,
  ) => {
    onSessionChange?.(nextSession.id)
    setContextTokens(0)
    setLastDuration(null)
    setScrollOffset(0)
    let loadedMessages = nextSession.messages
    if (nextSession.refreshHistory) {
      try {
        const refreshed = await nextSession.refreshHistory()
        if (refreshed.length > 0) loadedMessages = refreshed
      } catch {
        // Fall back to whatever messages are already loaded in memory.
      }
    }
    const nextFolder = nextSession.project?.ok ? nextSession.project.project.path : null
    updateFolder(nextFolder)
    updateBackend(nextSession.backend?.kind ?? 'milo')
    const nextStats = nextSession.stats?.()
    updateMaxTokens(nextStats?.maxInputTokens)
    if (nextStats && nextStats.tokens > 0) setContextTokens(nextStats.tokens)
    if (hydrate) {
      const hydrated =
        Array.isArray(loadedMessages) && loadedMessages.length > 0
          ? itemsFromMessages(loadedMessages, display)
          : []
      setItems(hydrated)
    } else {
      setItems([])
    }
  }

  const buildCliCommandContext = (
    session: Awaited<ReturnType<AgentRuntime['getSession']>>,
  ): CommandContext => ({
    policy:
      runtime.permissions ??
      ({ mode, setMode: () => {} } as unknown as PermissionPolicy),
    resetSession: async () => {
      await session.clear?.()
      setItems([])
      setContextTokens(0)
    },
    persistMode: onModeChange,
    display,
    persistDisplay: onDisplayChange,
    effort: runtime.reasoningEffort,
    persistEffort: onEffortChange,
    providers: listProviders(),
    currentProvider: runtime.provider?.id,
    persistProvider: runtime.setProvider
      ? (id) => {
          runtime.setProvider(id)
          setProvider(runtime.provider.id, runtime.model)
          onConfigRefresh?.()
          return {
            provider: runtime.provider.id,
            name: runtime.providerName,
            model: runtime.model,
          }
        }
      : undefined,
    models: runtime.provider?.id
      ? () => listProviderModels(runtime.provider.id)
      : undefined,
    currentModel: runtime.model,
    persistModel: runtime.setModel
      ? (id) => {
          runtime.setModel(id)
          setProvider(runtime.provider.id, runtime.model)
          onConfigRefresh?.()
          return { model: runtime.model }
        }
      : undefined,
    newSession: async (title) => {
      const nextSession = await runtime.newSession(scope, title)
      await applySwitchedSession(nextSession, false)
      return nextSession
    },
    resumeSession: async (id) => {
      const nextSession = await runtime.resumeSession(scope, id)
      if (!nextSession) return false
      await applySwitchedSession(nextSession, true)
      return true
    },
    forkSession: async (targetId, options) => {
      const source = targetId ?? session.id
      const forked = await runtime.forkSession(scope, source, options)
      if (!forked) return null
      await applySwitchedSession(forked, true)
      return forked
    },
    sessionFolder: () => activeFolder,
    setSessionFolder: runtime.setSessionFolder
      ? async (nextFolder) => {
          await runtime.setSessionFolder(session.id, nextFolder)
          const resolved = session.project?.ok ? session.project.project.path : null
          updateFolder(resolved)
          return resolved
        }
      : undefined,
    listSessions: runtime.listSessions ? () => runtime.listSessions() : undefined,
    sessionStats: session.stats ? () => session.stats() : undefined,
    compactSession: session.compact ? () => session.compact() : undefined,
    skills: () => runtime.skills ?? [],
    jobs: () => runtime.jobs?.list(sessionId ?? undefined) ?? [],
    killJob: (id) => runtime.jobs?.kill(id, sessionId ?? undefined) ?? false,
    memories: (limit, query, offset) => session.memories(limit, query, offset),
    updateMemory: (id, text) => session.updateMemory(id, text),
    forgetMemory: (id) => session.forget(id),
  })

  const runCommand = async (raw: string) => {
    const [rawCmd, ...rest] = raw.slice(1).trim().split(/\s+/)
    const command = (rawCmd ?? '').toLowerCase()
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
        if (!argument.trim()) {
          onOpenModel()
          return
        }
        break
      case 'setup':
        onOpenSettings()
        return
      case 'exit':
      case 'quit':
        onExit()
        return
      case 'stop':
      case 'steer':
      case 'queue': {
        const result = handleTurnControl(raw, {
          turn: controlTarget(),
          start: (pending) => submit(pending, false),
        })
        if (result.reply) push({ kind: 'info', text: result.reply })
        return
      }
      case 'sessions':
        if (argument.trim().toLowerCase() === 'pick') {
          await openSessionPicker()
          return
        }
        break
      case 'resume':
        if (!argument.trim()) {
          await openSessionPicker()
          return
        }
        break
      case 'folder':
        if (!argument.trim() || argument.trim().toLowerCase() === 'pick') {
          await openFolderPicker()
          return
        }
        break
      case 'stats': {
        const session = await runtime.getSession(scope)
        const stats = session.stats()
        updateMaxTokens(stats.maxInputTokens)
        push({ kind: 'fields', rows: statsRows(stats) })
        return
      }
      case 'compact': {
        const session = await runtime.getSession(scope)
        setPhase('compacting')
        setStartedAt(Date.now())
        try {
          const result = await handleCommand(raw, buildCliCommandContext(session))
          if (result.handled && result.reply) push({ kind: 'info', text: result.reply })
        } finally {
          setPhase('idle')
        }
        return
      }
      default:
        break
    }

    const session = await runtime.getSession(scope)
    const result = await handleCommand(raw, buildCliCommandContext(session))
    if (result.handled && result.reply) {
      push({ kind: 'info', text: result.reply })
    } else if (!result.handled) {
      push({ kind: 'info', text: `Unknown command: /${command} — try /help` })
    }
  }

  /** Files what has been streamed so far as a finished item. */
  const commitLive = () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const text = liveRef.current
    liveRef.current = ''
    setLive('')
    if (text.trim()) push({ kind: 'assistant', text })
  }

  const runTurn = async (text: string, images: ImagePart[] = [], model?: string, audio: AudioPart[] = [], documents: DocumentPart[] = [], imagesForDisplayOnly = false, displayText?: string, mediaNotices?: string[]) => {
    setScrollOffset(0)
    setLive('')
    liveRef.current = ''
    setReasoning('')
    reasoningRef.current = ''
    draftUiActiveRef.current = false
    setToolName('')
    setPhase('thinking')
    setStartedAt(Date.now())

    const controller = new AbortController()
    abortRef.current = controller
    // This turn's inbox. The surface writes into it, the loop empties it.
    const steering: string[] = []
    steeringRef.current = steering
    const startedAtMs = Date.now()
    // Each wait is its own block: from the question to the model's first visible
    // output, then from the last tool result to the next one. Reasoning deltas do
    // not end it — they *are* the thinking; they are what fills the block.
    let waitingSince = startedAtMs
    /** Whether anything arrived in the answer channel at all. */
    let answered = false
    /** Reasoning seen this turn, counted even when it is not kept. */
    let reasoningChars = 0
    /** Thinking too fast to be worth a line, kept in case it was the answer. */
    const dropped: string[] = []
    const stopWaiting = () => {
      flushStream()
      const seconds = (Date.now() - waitingSince) / 1000
      waitingSince = Date.now()
      const thought = reasoningRef.current.trim()
      reasoningRef.current = ''
      setReasoning('')
      // Under a second with nothing to account for there is nothing worth saying
      // — unless the thought is all the turn has said, which is only known at the
      // end.
      if (seconds < 1) {
        if (thought) dropped.push(thought)
        return
      }
      push({ kind: 'reasoning', header: `✻ Thought for ${formatSeconds(seconds)}`, text: thought })
    }

    try {
      const session = await runtime.getSession(scope)
      for await (const event of session.send(text, {
        signal: controller.signal,
        ask,
        steering,
        images,
        audio,
        documents,
        imagesForDisplayOnly,
        displayText,
        mediaNotices,
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
            setPhase('writing')
            scheduleFlush()
          },
          onReasoning: (delta) => {
            // Counted whatever the level: a turn that says nothing in the answer
            // channel is worth explaining, and that is all that is left to go on.
            reasoningChars += delta.length
            // `collapsed` keeps only the line above: nothing on the terminal is
            // going to display the text, and it has no way to open it.
            if (display.thinking === 'collapsed') return
            reasoningRef.current += delta
            scheduleFlush()
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
            draftUiActiveRef.current = false
            // `off` keeps tool activity out of the transcript and out of the
            // status line, so the turn reads as plain thinking. A tool whose own
            // call is not drawn never reaches the status line either.
            if (display.tools === 'off' || !showsToolCall(name)) return
            setToolName(name)
            setPhase('tool')
          },
          onToolEnd: (name, result, isError, change) => {
            // A failure is always shown, even with tools off.
            if ((display.tools !== 'off' && showsToolCall(name)) || isError) {
              push({
                kind: 'tool',
                name,
                detail: display.tools === 'name' ? '' : toolDetail(toolArgsRef.current),
                ok: !isError,
                counts: display.tools === 'full' ? changeCounts(change) : '',
                args: toolArgsRef.current,
                result,
                change,
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
          onTodo: (todoItems) => push({ kind: 'todo', items: todoItems }),
          onSteer: (steerText) => push({ kind: 'steer', text: steerText }),
          onUi: (render, draft) => {
            const nextItem: Item = {
              kind: 'ui',
              ...(render.title ? { title: render.title } : {}),
              summary: summarizeGenUi(render),
            }
            if (draftUiActiveRef.current) {
              setItems((current) => {
                for (let i = current.length - 1; i >= 0; i -= 1) {
                  if (current[i]?.kind === 'ui') {
                    const updated = [...current]
                    updated[i] = nextItem
                    return updated
                  }
                }
                return [...current, nextItem]
              })
            } else {
              push(nextItem)
            }
            draftUiActiveRef.current = Boolean(draft)
          },
          onPanel: (request) => {
            const detail = describePanelRequest(request)
            if (detail) push({ kind: 'panel', detail })
          },
          // The gate's report arrives after the answer, as its own block.
          onVerification: (ok, verificationText) => push({ kind: 'verification', ok, text: verificationText }),
          onUsage: (inputTokens) => setContextTokens(inputTokens),
          // The band says the fold is running; the transcript gets what it came to
          // once it is over. The clock starts again there, so the fold is counted
          // in its own line rather than in the model's wait beside it.
          onCompacting: () => setPhase('compacting'),
          onCompacted: (fold) => {
            waitingSince = Date.now()
            setPhase('thinking')
            push({ kind: 'info', text: compactReply(fold) })
          },
          // The status line carries the wait while it lasts; the transcript gets
          // it once it is over, with what it actually cost.
          onWaiting: () => setPhase('waiting'),
          onWaited: (ms) => {
            waitingSince = Date.now()
            setPhase('thinking')
            push({ kind: 'info', text: `⏳ waited ${formatSeconds(ms / 1000)} for another Milo.` })
          },
          onRebased: (rebasedEvent) => {
            const notice: Item = {
              kind: 'info',
              text: `↺ another Milo has used this session: ${describeRebase(rebasedEvent)}.`,
            }
            if (Array.isArray(session.messages) && session.messages.length > 0) {
              setItems([...itemsFromMessages(session.messages, display), notice])
            } else {
              push(notice)
            }
          },
          onDone: (finishReason) => {
            flushStream()
            // A capped answer otherwise looks like a complete one.
            if (finishReason === 'length') {
              push({
                kind: 'info',
                text: '⚠ hit the output limit — the answer was cut off. Raise "maxTokens" in config.yml.',
              })
            }
          },
          onAborted: () => {
            flushStream()
            push({ kind: 'info', text: 'stopped.' })
          },
          onError: (message) => {
            flushStream()
            push({ kind: 'error', text: message })
          },
        })
      }
      const nextStats = session.stats?.()
      if (nextStats?.maxInputTokens !== undefined) updateMaxTokens(nextStats.maxInputTokens)
    } catch (error) {
      flushStream()
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
    if (!answered && reasoningChars > 0 && display.thinking === 'collapsed') {
      push({
        kind: 'info',
        text:
          '⚠ no answer came back: this model sends everything it says as reasoning, and ' +
          '/thinking collapsed hides it. MILO_DEBUG=1 prints what the wire carried.',
      })
    }

    commitLive()
    draftUiActiveRef.current = false
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
          const queued = queueRef.current.shift() as { text: string; images: ImagePart[]; audio: AudioPart[]; documents?: DocumentPart[]; imagesForDisplayOnly?: boolean; displayText?: string; mediaNotices?: string[]; model?: string }
          setQueued(queueRef.current.length)
          try {
            await runTurn(queued.text, queued.images, queued.model, queued.audio, queued.documents, queued.imagesForDisplayOnly, queued.displayText, queued.mediaNotices)
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
    let documents: DocumentPart[] = []
    let imagesForDisplayOnly = false
    let mediaNotices: string[] | undefined
    let prompt = text
    let mediaModel: string | undefined
    const attachmentBase = activeFolder ?? baseCwd
    try {
      if (fileTokens.length) {
        const sizes = await Promise.all(
          fileTokens.map((file) => stat(resolveToolPath(attachmentBase, file))),
        )
        if (sizes.some((info) => info.size > MAX_INCOMING_BYTES)) throw new Error('A file is larger than 50 MB.')
        if (sizes.reduce((total, info) => total + info.size, 0) > MAX_INCOMING_TOTAL_BYTES) throw new Error('Attachments together are larger than 50 MB.')
        const files = await Promise.all(fileTokens.map(async (file) => {
          const resolved = resolveToolPath(attachmentBase, file)
          const bytes = await readFile(resolved)
          const ext = path.extname(file).toLowerCase()
          const mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain', '.md': 'text/markdown' } as Record<string, string>)[ext] ?? 'application/octet-stream'
          return { name: path.basename(file), mimeType, data: bytes }
        }))
        const session = await runtime.getSession(scope)
        const prepared = await prepareTurnMedia(session, text, files)
        prompt = prepared.prompt
        images = prepared.images
        audio = prepared.audio
        documents = prepared.documents
        imagesForDisplayOnly = prepared.imagesForDisplayOnly
        mediaNotices = prepared.notices
        mediaModel = prepared.model
        for (const notice of prepared.notices) push({ kind: 'error', text: notice })
      }
    } catch (error) {
      push({ kind: 'error', text: `Could not read attachment: ${errorMessage(error)}` })
      return
    }
    prompt ||= 'Please inspect the attached media.'
    setInput('')
    remember(rawText)

    // Whatever was typed lands in the transcript, commands included: it is one
    // line of the conversation being read back, and a command that left no
    // trace read as if it had never been sent. Filing the answer still
    // streaming first is what keeps the order.
    commitLive()
    push({ kind: 'user', text: rawText })
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
    if (steer && steering && fileTokens.length === 0) {
      steering.push(prompt)
      return
    }
    queueRef.current.push({ text: prompt, images, audio, documents, imagesForDisplayOnly, displayText: rawText, mediaNotices, ...(mediaModel ? { model: mediaModel } : {}) })
    setQueued(queueRef.current.length)
    pump()
  }

  const statusLabel =
    phase === 'asking'
      ? 'waiting for confirmation'
      : phase === 'compacting'
        ? 'folding the oldest turns into the summary…'
        : phase === 'waiting'
          ? 'waiting for another Milo on this session…'
          : phase === 'tool'
            ? `${toolName}…`
            : phase === 'writing'
              ? 'writing…'
              : 'thinking…'

  const statusText = `${statusLabel} ${formatSeconds(elapsed)}${queued > 0 ? ` · ${queued} queued` : ''}`
  const scrolled = window.offset > 0 ? `▲ scrolled (${window.offset}/${window.maxOffset})` : ''
  const idleText = flashNotice || scrolled
  const contextRatio =
    contextTokens > 0 && budgetTokens && budgetTokens > 0 ? contextTokens / budgetTokens : 0
  const contextColor =
    contextRatio >= 0.9
      ? activeTheme.danger
      : contextRatio >= 0.7
        ? activeTheme.warning
        : activeTheme.muted
  const contextText =
    contextTokens > 0
      ? budgetTokens
        ? `◔ ${formatTokens(contextTokens)}/${formatTokens(budgetTokens)} tok`
        : `◔ ${formatTokens(contextTokens)} tok`
      : ''
  const counterParts: Array<{ text: string; color: ThemeColor }> = [
    ...(runningJobs > 0
      ? [{ text: `↻ ${runningJobs} job${runningJobs === 1 ? '' : 's'}`, color: activeTheme.muted }]
      : []),
    ...(!busy && lastDuration !== null
      ? [{ text: `last ${formatSeconds(lastDuration)}`, color: activeTheme.muted }]
      : []),
    ...(contextText ? [{ text: contextText, color: contextColor }] : []),
  ]
  const countersWidth = counterParts.reduce(
    (total, part, index) => total + part.text.length + (index > 0 ? 3 : 0),
    0,
  )
  // One band under the composer: what the request runs on, and where it is going,
  // said once. Each field is a muted label and a value that carries the colour, so
  // the eye lands on what is set rather than on the word naming it. The model's own
  // name already says where the request goes, so the provider is not repeated; a
  // flag that takes something away wears the warning or danger tone; and the fields
  // drop from the end when the line does not fit, the session id first — the state
  // that takes something away outlives the id nobody has to read twice.
  const footerParts: FooterPart[] = [
    ...(model
      ? [
          { text: model.model, color: activeTheme.accent, bold: true },
          { label: 'effort', text: model.effort, color: activeTheme.secondary },
        ]
      : [{ text: 'Milo', color: activeTheme.muted }]),
    ...(activeBackend && activeBackend !== 'milo'
      ? [{ text: activeBackend, color: activeTheme.secondary }]
      : []),
    ...(mode !== 'ask'
      ? [
          {
            text: PERMISSION_LABELS[mode],
            color: mode === 'yolo' ? activeTheme.danger : activeTheme.warning,
            bold: mode === 'yolo',
          },
        ]
      : []),
    ...(display.tools !== 'full' ? [{ label: 'tools', text: display.tools, color: activeTheme.warning }] : []),
    ...(display.thinking === 'collapsed' ? [{ label: 'thinking', text: 'collapsed', color: activeTheme.warning }] : []),
    ...(mouseOff ? [{ text: 'mouse off', color: activeTheme.warning }] : []),
    ...(folderLabel ? [{ label: 'folder', text: folderLabel, color: activeTheme.secondary }] : []),
    ...(sessionId ? [{ label: 'session', text: sessionId, color: activeTheme.muted }] : []),
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
  const jobText = jobNotice ? `job ${jobNotice} finished — Milo is on it…` : ''
  const statusWidth = busy
    ? statusText.length + 2
    : jobNotice
      ? jobText.length + 2
      : idleText ? idleText.length + 2 : 0
  const showCounters = counterParts.length > 0 && statusWidth + countersWidth <= columns - 4

  const thumbHeight = scrollable
    ? Math.max(1, Math.min(chatHeight, Math.round((chatHeight / allLines.length) * chatHeight)))
    : 0
  const trackSpan = Math.max(0, chatHeight - thumbHeight)
  const topRatio = window.maxOffset > 0 ? (window.maxOffset - window.offset) / window.maxOffset : 1
  const thumbStart = Math.round(topRatio * trackSpan)
  const thumbEnd = thumbStart + thumbHeight

  return (
    <Box flexDirection="column" height={rows - HEADER_ROWS} width={columns}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {bodyLines.map((line, index) => {
          const textColor = line.color ?? (line.dim ? activeTheme.muted : undefined)
          const isThumb = scrollable && index >= thumbStart && index < thumbEnd
          return (
            // Every line is its own row box, inset where the transcript is; a line
            // carrying a background fills the whole row, the way the composer does,
            // and the ones without one are transparent and read as plain text.
            // biome-ignore lint/suspicious/noArrayIndexKey: the window is rebuilt every frame and never reorders
            <Box key={index} width={columns} paddingX={2} backgroundColor={line.background}>
              <Box flexGrow={1}>
                <Text color={textColor}>
                  {line.segments
                    ? line.segments.map((segment, segmentIndex) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: segments are re-wrapped every frame and never reorder
                        <Text key={segmentIndex} {...segmentStyle(segment)}>
                          {segment.text}
                        </Text>
                      ))
                    : line.text || ' '}
                </Text>
              </Box>
              {scrollable ? (
                <Box width={2} justifyContent="flex-end">
                  <Text color={isThumb ? activeTheme.accent : activeTheme.muted}>
                    {isThumb ? '┃' : '┆'}
                  </Text>
                </Box>
              ) : null}
            </Box>
          )
        })}
      </Box>

      <Box paddingX={2} width={columns} justifyContent="space-between">
        {busy ? (
          <Text color={activeTheme.warning}>
            <Spinner type="dots" /> {statusText}
          </Text>
        ) : jobNotice ? (
          <Text color={activeTheme.warning}>
            <Spinner type="dots" /> {jobText}
          </Text>
        ) : flashNotice ? (
          <Text color={activeTheme.secondary}>{flashNotice}</Text>
        ) : scrolled ? (
          <Text color={activeTheme.secondary}>{scrolled}</Text>
        ) : (
          <Text> </Text>
        )}
        {showCounters ? (
          <Text>
            {counterParts.map((part, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: counter parts are rebuilt every frame
              <Text key={index}>
                {index > 0 ? <Text color={activeTheme.muted}> · </Text> : null}
                <Text color={part.color}>{part.text}</Text>
              </Text>
            ))}
          </Text>
        ) : null}
      </Box>

      {activePicker === 'sessions' ? (
        <SessionPicker
          sessions={pickerSessions}
          projectNames={pickerProjects}
          currentSessionId={sessionId}
          maxHeight={pickerHeight}
          columns={columns}
          theme={activeTheme}
          onSelect={(pickedId) => {
            setActivePicker(null)
            if (pickedId === sessionId) return
            void (async () => {
              const next = await runtime.resumeSession(scope, pickedId)
              if (next) {
                await applySwitchedSession(next, true)
                push({ kind: 'info', text: `Switched to session ${next.id}.` })
              } else {
                push({ kind: 'info', text: `No session "${pickedId}".` })
              }
            })().catch((error) => push({ kind: 'error', text: errorMessage(error) }))
          }}
          onCancel={() => setActivePicker(null)}
        />
      ) : activePicker === 'folder' ? (
        <FolderPicker
          currentFolder={activeFolder}
          recentFolders={pickerRecentFolders}
          maxHeight={pickerHeight}
          columns={columns}
          theme={activeTheme}
          onSelect={(folderPath) => {
            setActivePicker(null)
            void (async () => {
              const session = await runtime.getSession(scope)
              if (!runtime.setSessionFolder) {
                push({ kind: 'info', text: 'Session folder selection is not available on this surface.' })
                return
              }
              await runtime.setSessionFolder(session.id, folderPath)
              const resolved = session.project?.ok ? session.project.project.path : null
              updateFolder(resolved)
              push({
                kind: 'info',
                text: resolved ? `Session folder: ${resolved}.` : 'Session folder: Default directory.',
              })
            })().catch((error) => push({ kind: 'error', text: errorMessage(error) }))
          }}
          onCancel={() => setActivePicker(null)}
        />
      ) : permission ? (
        <Box flexDirection="column" paddingX={2}>
          <Text color={activeTheme.warning}>⚠ Milo wants to run {toolDisplayName(permission.tool)}:</Text>
          <Text color={activeTheme.warning}>  {permission.summary}</Text>
          {permission.approvalScope && <Text color={activeTheme.muted}>  {permission.approvalScope}</Text>}
          <Text color={activeTheme.muted}>{permission.approvalScope ? '[y] allow · [a] allow for session · [n] deny' : '[y] allow · [n] deny'}</Text>
        </Box>
      ) : (
        <Composer
          value={input}
          onChange={setInput}
          onSubmit={(submitted, steer) => {
            void submit(submitted, steer).catch((error) => push({ kind: 'error', text: errorMessage(error) }))
          }}
          onRecallHistory={recallHistory}
          onScroll={scrollBy}
          onPopupRowsChange={setPopupRows}
          commands={COMMAND_CATALOG}
          suggestFiles={suggestFiles}
          busy={busy}
          disabled={Boolean(permission || activePicker)}
          columns={columns}
          maxVisibleLines={maxComposerLines}
          maxPopupRows={maxPopupRows}
          theme={activeTheme}
        />
      )}

      <Box paddingX={2} width={columns}>
        {footerParts.map((part, index) => (
          <Text key={`${part.label ?? ''}:${part.text}`}>
            {index > 0 ? <Text color={activeTheme.muted}> · </Text> : null}
            {part.label ? <Text color={activeTheme.muted}>{part.label} </Text> : null}
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
  onToolEnd: (name: string, result: string, isError: boolean, change?: FileChange[]) => void
  /** The plan the model is keeping, in full, each time it changes. */
  onTodo: (items: TodoItem[]) => void
  /** A steering correction delivered to the running turn. */
  onSteer: (text: string) => void
  /** A generated interface block rendered beside the transcript. */
  onUi: (render: GenUiRender, draft?: boolean) => void
  /** A panel request emitted by the turn. */
  onPanel: (request: PanelRequest) => void
  /** The project's checks, after a turn that wrote. */
  onVerification: (ok: boolean, text: string) => void
  /** What the last request cost in input tokens: the size of the session as sent. */
  onUsage: (inputTokens: number) => void
  /** The oldest turns are being folded into the summary right now. */
  onCompacting: () => void
  /** What that fold came to: the turns, the tokens, the time, and whether it summarized. */
  onCompacted: (fold: { folded: number; tokens: number; ms: number; summarized: boolean }) => void
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
      handlers.onToolEnd(event.name, event.result, event.isError, event.change)
      break
    case 'todo':
      handlers.onTodo(event.items)
      break
    case 'steer':
      handlers.onSteer(event.text)
      break
    case 'ui':
      handlers.onUi(event.render, event.draft)
      break
    case 'panel':
      handlers.onPanel(event.request)
      break
    case 'verification':
      handlers.onVerification(event.ok, event.text)
      break
    case 'usage':
      handlers.onUsage(event.inputTokens)
      break
    case 'compacting':
      handlers.onCompacting()
      break
    case 'compacted':
      handlers.onCompacted(event)
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

/** `1 turn`, `2 turns` — "1 turns" is the kind of thing that makes a block look unfinished. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
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

const EMPTY_HINT_ITEMS: Array<{ key: string; label?: string }> = [
  { key: 'Enter', label: 'send' },
  { key: 'Shift+Enter', label: 'newline' },
  { key: 'Ctrl+S', label: 'sessions' },
  { key: '/folder', label: 'workspace' },
  { key: '@file', label: 'attach' },
  { key: '/help' },
]

function segmentStyle(segment: LineSegment): {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: ThemeColor
} {
  return {
    bold: segment.bold,
    italic: segment.italic,
    underline: segment.underline,
    color: segment.color,
  }
}

function hintRows(width: number, activeTheme: TuiTheme): Line[] {
  const rows: Array<Array<{ key: string; label?: string }>> = []
  let current: Array<{ key: string; label?: string }> = []
  let currentWidth = 0

  for (const item of EMPTY_HINT_ITEMS) {
    const itemText = item.label ? `${item.key} ${item.label}` : item.key
    const added = current.length === 0 ? itemText.length : 3 + itemText.length
    if (current.length > 0 && currentWidth + added > width) {
      rows.push(current)
      current = [item]
      currentWidth = itemText.length
    } else {
      current.push(item)
      currentWidth += added
    }
  }
  if (current.length > 0) rows.push(current)

  return rows.map((row) => {
    const segments: LineSegment[] = []
    let plain = ''
    row.forEach((item, index) => {
      if (index > 0) {
        segments.push({ text: ' · ', color: activeTheme.muted })
        plain += ' · '
      }
      segments.push({ text: item.key, color: activeTheme.secondary })
      plain += item.key
      if (item.label) {
        segments.push({ text: ` ${item.label}`, color: activeTheme.muted })
        plain += ` ${item.label}`
      }
    })
    return { text: plain, segments }
  })
}

function emptyHeroLines({
  chatHeight,
  columns,
  width,
  activeTheme,
  modelName,
  folderLabel,
}: {
  chatHeight: number
  columns: number
  width: number
  activeTheme: TuiTheme
  modelName?: string
  folderLabel: string | null
}): Line[] {
  const [topMark, midMark, bottomMark] = miloMarkRows(activeTheme)

  if (chatHeight < 8 || columns < 44) {
    const readySuffix = width >= 12 ? ' · ready' : ''
    const readyLine: Line = {
      text: truncateLine(`MILO${readySuffix}`, width),
      segments: [
        { text: 'MILO', bold: true, color: topMark.color },
        ...(readySuffix ? [{ text: readySuffix, color: activeTheme.muted }] : []),
      ],
    }
    if (chatHeight < 2) return [readyLine]
    const subText = width >= 25 ? 'Ask Milo anything · /help' : truncateLine('Ask Milo · /help', width)
    return [readyLine, { text: subText, color: activeTheme.muted }]
  }

  const markWidth = topMark.text.length + 2
  const folderText = truncateLine(folderLabel ?? 'Default directory', Math.max(8, width - markWidth))
  const maxModelWidth = Math.max(0, width - markWidth - 'MILO'.length - 3)
  const fittedModel = modelName && maxModelWidth >= 4 ? truncateLine(modelName, maxModelWidth) : ''

  const titleSegments: LineSegment[] = [
    ...topMark.segments,
    { text: '  ' },
    { text: 'MILO', bold: true, color: topMark.color },
    ...(fittedModel
      ? [
          { text: ' · ', color: activeTheme.muted },
          { text: fittedModel, color: activeTheme.secondary },
        ]
      : []),
  ]

  const folderSegments: LineSegment[] = [
    ...midMark.segments,
    { text: '  ' },
    { text: folderText, color: activeTheme.muted },
  ]

  return [
    { text: titleSegments.map((segment) => segment.text).join(''), segments: titleSegments },
    { text: folderSegments.map((segment) => segment.text).join(''), segments: folderSegments },
    { text: bottomMark.text, segments: bottomMark.segments },
    { text: '' },
    ...hintRows(width, activeTheme),
  ]
}
