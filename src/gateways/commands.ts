import type { AgentRuntime } from '../core/runtime.js'
import type { Session } from '../core/session.js'
import type { MemoryScope } from '../core/memory/index.js'
import { listProviderModels, listProviders, readDisplay, setDisplay, setPermissionMode, setModel, setProvider, setReasoningEffort } from '../core/config/load.js'
import { describeExport, writeSessionExport, type ExportFormat } from '../core/export.js'
import { formatStats, formatWhen } from '../core/sessions/index.js'
import type { CompactResult, SessionStats, SessionSummary } from '../core/sessions/index.js'
import { formatSkillList, type SkillSummary } from '../core/skills/index.js'
import { DEFAULT_DISPLAY, type DisplayConfig } from '../core/config/schema.js'
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../core/providers/types.js'
import type { ModelInfo } from '../core/providers/models.js'
import type { PermissionMode, PermissionPolicy } from '../core/tools/permission.js'
import type { MemoryItem } from '../core/memory/index.js'
import type { TurnQueue } from './turns.js'
import { buildSessionsList, type ActionRow, type SessionCardItem } from './actions.js'
import { normalize } from './access.js'
import { errorMessage } from '../util/errors.js'

export interface CommandContext {
  policy?: PermissionPolicy
  resetSession?: () => void | Promise<void>
  status?: string
  /** Writes the new mode to disk, so it survives a restart. */
  persistMode?: (mode: PermissionMode) => void
  /** Set when this surface is not allowed to change the mode; used as the reply. */
  modeLocked?: string
  /** How much of a tool call this surface is showing right now. */
  display?: DisplayConfig
  /** Applies a display change to the running surface and writes it down. */
  persistDisplay?: (patch: Partial<DisplayConfig>) => void
  /** Set when this surface may not change the display settings; used as the reply. */
  displayLocked?: string
  /** How hard the model thinks right now. */
  effort?: ReasoningEffort
  /** Applies a reasoning-effort change to the running session and writes it down. */
  persistEffort?: (effort: ReasoningEffort) => void
  /** Set when this surface may not change how hard the model thinks; used as the reply. */
  effortLocked?: string
  /** The providers this install can talk through, for `/provider`. */
  providers?: { id: string; name: string }[]
  /** The provider in use, so `/provider` can mark it. */
  currentProvider?: string
  /** Switches the provider live and writes it down; returns what it landed on. */
  persistProvider?: (id: string) => { provider: string; name: string; model: string }
  /** Set when this surface may not change the provider; used as the reply. */
  providerLocked?: string
  /** The current provider's models, for `/model`. */
  models?: () => Promise<ModelInfo[]>
  /** The model in use, so `/model` can mark it. */
  currentModel?: string
  /** Switches the model live and writes it down; returns what it landed on. */
  persistModel?: (id: string) => { model: string }
  /** Set when this surface may not change the model; used as the reply. */
  modelLocked?: string
  /** Starts a fresh session and binds it to this conversation. */
  newSession?: (title?: string) => Promise<{ id: string }>
  /** Binds this conversation to an existing session. */
  resumeSession?: (id: string) => Promise<boolean>
  /** Forks the current session or a named one into a new session. */
  forkSession?: (id?: string, options?: { upToTurn?: number }) => Promise<{ id: string } | null>
  listSessions?: () => Promise<SessionSummary[]>
  sessionStats?: () => SessionStats | Promise<SessionStats>
  /** Folds the oldest turns into the summary now, rather than when the budget forces it. */
  compactSession?: () => Promise<CompactResult>
  /** The skills installed on this machine, for `/skills`. */
  skills?: () => SkillSummary[]
  /** What this install remembers, for `/memory`. */
  memories?: (limit?: number) => Promise<MemoryItem[]>
  /** Drops one remembered note, by id or the front of one. */
  forgetMemory?: (id: string) => Promise<boolean>
  /** Set when this surface may not read or drop memories; used as the reply. */
  memoryLocked?: string
  /** Set when this surface may not create or switch sessions; used as the reply. */
  sessionLocked?: string
}

export interface CommandResult {
  handled: boolean
  reply?: string
  /** The same reply with Markdown, for surfaces that render it. */
  markdown?: string
  /** Optional interactive action buttons for surfaces that support them. */
  actions?: ActionRow[]
  /** Optional rich session cards for surfaces that support rich cards (e.g. web). */
  cards?: SessionCardItem[]
  /** Optional pagination info, e.g. for surfaces that render navigation buttons. */
  pagination?: {
    page: number
    totalPages: number
    totalItems: number
    pageSize: number
  }
}

const HELP = [
  'Commands:',
  '/mode ask|auto|yolo — permission mode, saved for every surface',
  '/yolo — toggle yolo mode',
  '/tools full|name|off — how much of each tool call to show',
  '/thinking on|off — show the model\'s reasoning (display only; /effort is what changes how it thinks)',
  "/effort low|medium|high — how hard the model thinks (the one that costs)",
  '/provider [id] — the provider the install answers with: list them, or switch to one',
  "/model [id] — the model the install answers with: list the current provider's, or switch to one",
  '/new [title] — start a new session',
  '/sessions [page] — list saved sessions',
  '/resume <id> — switch to another session',
  '/fork [id] [turn] — branch into a new session from this or a named session',
  '/stats — numbers for the current session',
  '/compact — fold the oldest turns into the summary now, instead of when the context fills up',
  '/export [md|json] — write this conversation out as a file, tool calls and reasoning included',
  '/skills — the skills installed, and where they live',
  '/memory [forget <id>] — what Milo keeps, and how to drop one of them',
  '/clear — forget this conversation',
  '/status — permission mode and display settings',
  '/stop — stop the turn running now, and anything queued behind it',
  '/steer <text> — hand text to the turn running now, at its next step',
  '/queue <text> — say it as its own turn, after the one running now',
  '/help — this message',
  'A plain message sent while Milo is working is a correction: it joins that turn at its next step instead of starting a second one. /queue is how you ask for it to be said afterwards.',
  'Adding a provider or a key: run `milo setup` in a terminal.',
].join('\n')

const TOOL_LEVELS = ['full', 'name', 'off'] as const

function describeDisplay(display: DisplayConfig | undefined): string {
  const settings = display ?? DEFAULT_DISPLAY
  return `Tools: ${settings.tools} · thinking display: ${settings.thinking}`
}

/** The providers available, the one in use marked — what `/provider` answers with. */
function describeProviders(providers: { id: string; name: string }[], current: string | undefined): string {
  if (providers.length === 0) {
    return 'No provider with a key is configured. Add one in `milo setup` → Provider & model, on the terminal.'
  }
  return [
    `Providers available (${providers.length}):`,
    ...providers.map((item) => `  ${item.id} — ${item.name}${item.id === current ? ' (current)' : ''}`),
    '',
    'Switch with /provider <id>.',
  ].join('\n')
}

/**
 * How many models a chat names before it stops and the id takes over: a list is
 * read on a phone, and a provider's catalog can run to hundreds.
 */
const MODEL_LIST_LIMIT = 20

/** The models the provider serves, the one in use first and marked — what `/model` answers with. */
function describeModels(provider: string, models: ModelInfo[], current: string | undefined): string {
  if (models.length === 0) {
    return `No models listed for ${provider}. Name one with /model <id>, or check the provider in \`milo setup\`.`
  }
  const ids = models.map((model) => model.id)
  // The one in use leads, so a catalog longer than a chat will show is not the
  // reason the model this install is running is the one missing from the list.
  const ordered = current && ids.includes(current) ? [current, ...ids.filter((id) => id !== current)] : ids
  const shown = ordered.slice(0, MODEL_LIST_LIMIT)
  const rest = ordered.length - shown.length
  return [
    `Models for ${provider} (${ordered.length}):`,
    ...shown.map((id) => `  ${id}${id === current ? ' (current)' : ''}`),
    ...(rest > 0 ? [`  … and ${rest} more — /model <id> takes the exact id.`] : []),
    '',
    'Switch with /model <id>.',
  ].join('\n')
}

/**
 * Who is asking, and what this surface answers: the two facts the lock needs.
 */
export interface LockOptions {
  /**
   * The ids this bot accepts, or absent on a surface that has no allowlist at all
   * — the web chat, whose token is the whole of the authorization.
   */
  allowlist?: string[]
  /** The sender's own id, when the surface has one. */
  userId?: string
}

/**
 * Whether this caller may change an install-wide setting from the chat, and what
 * to say when they may not.
 *
 * Only a bot that answers **exactly one person** may — and the entry has to be
 * that person's own id. A list of one that names a room is still a room: everyone
 * in it passes `isAllowed`, so one member could turn off confirmations or read
 * the others' sessions. A bot that answers anyone is the most exposed case of all,
 * and a surface with no allowlist is not a bot and is never locked this way.
 */
function lockedTo(command: string, where: string, options: LockOptions): string | undefined {
  if (!options.allowlist) return undefined
  const allowed = normalize(options.allowlist)
  if (options.userId !== undefined && allowed.size === 1 && allowed.has(options.userId)) {
    return undefined
  }
  const answers =
    allowed.size === 0
      ? 'this bot answers anyone'
      : allowed.size === 1
        ? 'this bot answers a room rather than one person'
        : `this bot answers ${allowed.size} ids`
  return `🔒 ${command} is locked while ${answers}. ${where}`
}

/** One policy for every surface; only the person the bot answers may change it from a chat. */
export function modeLockMessage(options: LockOptions): string | undefined {
  return lockedTo(
    '/mode',
    'Set the mode in `milo setup` on the terminal, or allow only your own id under Gateways.',
    options,
  )
}

/** Display settings are one value for the whole install, so one person would change what the others see. */
export function displayLockMessage(options: LockOptions): string | undefined {
  return lockedTo(
    '/tools and /thinking',
    'Set them in `milo setup` → Display, or allow only your own id under Gateways.',
    options,
  )
}

/** Effort is what an answer costs — a bill one person raises for everybody. */
export function effortLockMessage(options: LockOptions): string | undefined {
  return lockedTo(
    '/effort',
    'Set it in `milo setup` → Display on the terminal, or allow only your own id under Gateways.',
    options,
  )
}

/** The provider is where every answer is sent and billed. */
export function providerLockMessage(options: LockOptions): string | undefined {
  return lockedTo(
    '/provider',
    'Set the provider in `milo setup` on the terminal, or allow only your own id under Gateways.',
    options,
  )
}

/** The model decides which provider serves the answer and what it costs. */
export function modelLockMessage(options: LockOptions): string | undefined {
  return lockedTo(
    '/model',
    'Set the model in `milo setup` on the terminal, or allow only your own id under Gateways.',
    options,
  )
}

/** Sessions are per-person: one member listing or switching them would expose the others'. */
export function sessionLockMessage(options: LockOptions): string | undefined {
  return lockedTo(
    '/new, /sessions and /resume',
    'Manage sessions from the terminal, or allow only your own id under Gateways.',
    options,
  )
}

/** Memory is one store for the whole install: one member could read — or delete — what the owner told Milo. */
export function memoryLockMessage(options: LockOptions): string | undefined {
  return lockedTo(
    '/memory',
    'Run it in the terminal, or allow only your own id under Gateways.',
    options,
  )
}

export interface BuildCommandContextOptions {
  runtime: AgentRuntime
  scope: MemoryScope
  session: Session
  allowlist?: string[]
  /** The sender, when the surface knows them: what the single-person lock is decided on. */
  userId?: string
  signal?: AbortSignal
}

/**
 * Builds the standard CommandContext for a gateway turn, unifying permission,
 * session, display, and memory command handlers across Telegram, Discord, and Web.
 */
export function buildCommandContext(options: BuildCommandContextOptions): CommandContext {
  const { runtime, scope, session, allowlist, userId, signal } = options
  const lock: LockOptions = { allowlist, userId }
  return {
    policy: runtime.permissions,
    resetSession: () => session.clear(),
    persistMode: (mode) => {
      runtime.permissions?.setMode(mode)
      setPermissionMode(mode)
    },
    modeLocked: modeLockMessage(lock),
    sessionLocked: sessionLockMessage(lock),
    display: readDisplay(),
    persistDisplay: setDisplay,
    displayLocked: displayLockMessage(lock),
    effort: runtime.reasoningEffort,
    persistEffort: (effort) => {
      runtime.setReasoningEffort(effort)
      setReasoningEffort(effort)
    },
    effortLocked: effortLockMessage(lock),
    providers: listProviders(),
    currentProvider: runtime.provider.id,
    persistProvider: (id) => {
      runtime.setProvider(id)
      setProvider(runtime.provider.id, runtime.model)
      return { provider: runtime.provider.id, name: runtime.providerName, model: runtime.model }
    },
    providerLocked: providerLockMessage(lock),
    models: () => listProviderModels(runtime.provider.id),
    currentModel: runtime.model,
    persistModel: (id) => {
      runtime.setModel(id)
      setModel(runtime.model)
      return { model: runtime.model }
    },
    modelLocked: modelLockMessage(lock),
    newSession: (title) => runtime.newSession(scope, title),
    resumeSession: async (id) => (await runtime.resumeSession(scope, id)) !== null,
    forkSession: async (targetId, opts) => {
      const id = targetId ?? (await runtime.getSession(scope)).id
      const forked = await runtime.forkSession(scope, id, opts)
      return forked ? { id: forked.id } : null
    },
    listSessions: () => runtime.listSessions(),
    skills: () => runtime.skills,
    sessionStats: () => session.stats(),
    compactSession: () => session.compact(signal),
    memories: (limit) => session.memories(limit),
    forgetMemory: (id) => session.forget(id),
    memoryLocked: memoryLockMessage(lock),
  }
}


/** Enough of a note's id to name it without pasting a whole uuid into a chat. */
const MEMORY_ID_CHARS = 8

/** One note per line: what `/memory` shows on every surface. */
export function formatMemoryList(notes: MemoryItem[]): string {
  if (notes.length === 0) {
    return 'Nothing is remembered yet. Say something worth keeping, or ask me to remember it.'
  }
  return [
    `What Milo keeps (${notes.length}${notes.length === 1 ? ' note' : ' notes'}):`,
    // When, not just what: a note is something said at a moment, and without the
    // moment there is no telling a stale one from one from this morning. It is
    // when the note was last said, which is also what recall orders by.
    ...notes.map(
      (note) => `${note.id.slice(0, MEMORY_ID_CHARS)}  ${formatWhen(note.createdAt)}  ${note.text}`,
    ),
    '',
    `Dropping one: /memory forget <id> — the first ${MEMORY_ID_CHARS} characters are enough.`,
  ].join('\n')
}

/** Applies a mode change to the running policy and to disk. */
function applyMode(context: CommandContext, mode: PermissionMode): void {
  context.policy?.setMode(mode)
  context.persistMode?.(mode)
}

/** Splits `/command the rest` into the command and everything after it. */
function parse(raw: string): { command: string; argument: string } {
  const trimmed = raw.slice(1).trim()
  const spaceIndex = trimmed.search(/\s/)
  if (spaceIndex === -1) return { command: trimmed, argument: '' }
  return {
    command: trimmed.slice(0, spaceIndex),
    argument: trimmed.slice(spaceIndex + 1).trim(),
  }
}

/**
 * A `/fork` argument: an optional session id and an optional turn, in either
 * order. Parsed here, beside the command that documents the rule, so the terminal
 * and the chat gateways cannot come to read the same words differently.
 */
export function parseForkArgument(argument: string): { targetId?: string; upToTurn?: number } {
  const parts = argument.split(/\s+/).filter(Boolean)
  const targetId = parts[0] && !/^\d+$/.test(parts[0]) ? parts[0] : undefined
  const turnStr = parts[0] && /^\d+$/.test(parts[0]) ? parts[0] : parts[1]
  const upToTurn = turnStr && /^\d+$/.test(turnStr) ? Number.parseInt(turnStr, 10) : undefined
  return { targetId, upToTurn }
}

/** Handles the non-interactive slash commands shared by the gateways. */
export async function handleCommand(
  raw: string,
  context: CommandContext,
): Promise<CommandResult> {
  if (!raw.startsWith('/')) return { handled: false }

  const { command, argument } = parse(raw)

  switch (command) {
    case 'start':
    case 'help':
      return { handled: true, reply: HELP }

    case 'mode':
      if (context.modeLocked) return { handled: true, reply: context.modeLocked }
      if (argument === 'ask' || argument === 'auto' || argument === 'yolo') {
        applyMode(context, argument)
        return { handled: true, reply: `Permission mode: ${argument} — saved` }
      }
      return {
        handled: true,
        reply: `Permission mode: ${context.policy?.mode ?? 'ask'}. Use /mode ask|auto|yolo`,
      }

    case 'yolo': {
      if (context.modeLocked) return { handled: true, reply: context.modeLocked }
      const next: PermissionMode = context.policy?.mode === 'yolo' ? 'ask' : 'yolo'
      applyMode(context, next)
      return {
        handled: true,
        reply:
          next === 'yolo'
            ? '⚠ yolo mode ON — side-effecting tools run without confirmation. Saved for every surface.'
            : 'yolo mode off — back to asking. Saved for every surface.',
      }
    }

    case 'tools': {
      if (context.displayLocked) return { handled: true, reply: context.displayLocked }
      if (!context.persistDisplay) {
        return { handled: true, reply: 'Display settings are not available on this surface.' }
      }
      const level = argument.trim().toLowerCase()
      if (!(TOOL_LEVELS as readonly string[]).includes(level)) {
        return { handled: true, reply: `${describeDisplay(context.display)}. Use /tools full|name|off` }
      }
      const tools = level as DisplayConfig['tools']
      context.persistDisplay({ tools })
      return {
        handled: true,
        reply: `Tools: ${tools} — saved for every surface.${
          tools === 'off' ? ' A tool that fails is still reported.' : ''
        }`,
      }
    }

    case 'thinking': {
      if (context.displayLocked) return { handled: true, reply: context.displayLocked }
      if (!context.persistDisplay) {
        return { handled: true, reply: 'Display settings are not available on this surface.' }
      }
      const asked = argument.trim().toLowerCase()
      const current = context.display?.thinking ?? 'on'
      // `brief`/`full` are what this command used to take, and `true`/`false`
      // what the config used to hold: all four mean showing the reasoning or not.
      const level =
        asked === 'off' || asked === 'false'
          ? 'off'
          : asked === 'on' || asked === 'true' || asked === 'brief' || asked === 'full'
            ? 'on'
            : undefined
      if (!level) {
        return {
          handled: true,
          reply:
            `Thinking display: ${current}. This turns the showing of the reasoning on or off — ` +
            `the model thinks either way, and /effort is what changes that. Use /thinking on|off`,
        }
      }
      context.persistDisplay({ thinking: level })
      return {
        handled: true,
        reply:
          level === 'off'
            ? "Thinking display: off — none of the model's reasoning is shown. Saved for every surface. The model still thinks."
            : "Thinking display: on — the reasoning is shown under the question. Saved for every surface.",
      }
    }

    case 'effort': {
      if (context.effortLocked) return { handled: true, reply: context.effortLocked }
      if (!context.persistEffort) {
        return { handled: true, reply: 'Reasoning effort is not available on this surface.' }
      }
      const asked = argument.trim().toLowerCase()
      const level = (REASONING_EFFORTS as readonly string[]).includes(asked)
        ? (asked as ReasoningEffort)
        : asked === 'default' || asked === 'off'
          ? DEFAULT_REASONING_EFFORT
          : null
      if (level === null) {
        return {
          handled: true,
          reply: `Reasoning effort: ${context.effort ?? DEFAULT_REASONING_EFFORT}. Use /effort low|medium|high`,
        }
      }
      context.persistEffort(level)
      return {
        handled: true,
        reply: `Reasoning effort: ${level} — this one changes how the model answers, and what it costs. Saved for every surface.`,
      }
    }

    case 'provider': {
      if (context.providerLocked) return { handled: true, reply: context.providerLocked }
      const list = context.providers ?? []
      const asked = argument.trim()
      if (!asked) return { handled: true, reply: describeProviders(list, context.currentProvider) }
      // An id it does not know answers with the valid ones, never a silent fall
      // back to the provider already in use.
      if (!list.some((item) => item.id === asked)) {
        return { handled: true, reply: `No provider "${asked}".\n${describeProviders(list, context.currentProvider)}` }
      }
      if (!context.persistProvider) {
        return { handled: true, reply: 'Changing the provider is not available on this surface.' }
      }
      try {
        const landed = context.persistProvider(asked)
        return {
          handled: true,
          reply: `Provider: ${landed.name} — now answering with ${landed.model}. Saved for every surface.`,
        }
      } catch (error) {
        return { handled: true, reply: errorMessage(error) }
      }
    }

    case 'new': {
      if (context.sessionLocked) return { handled: true, reply: context.sessionLocked }
      if (!context.newSession) {
        return { handled: true, reply: 'Session switching is not available on this surface.' }
      }
      const { id } = await context.newSession(argument || undefined)
      return {
        handled: true,
        reply: `Started a new session: ${id}. /sessions to list, /resume ${id} to come back.`,
      }
    }

    case 'sessions': {
      if (context.sessionLocked) return { handled: true, reply: context.sessionLocked }
      if (!context.listSessions) {
        return { handled: true, reply: 'Session switching is not available on this surface.' }
      }
      const outcome = buildSessionsList(await context.listSessions(), argument)
      if (!outcome.ok) return { handled: true, reply: outcome.error }
      return { handled: true, ...outcome.result }
    }

    case 'resume': {
      if (context.sessionLocked) return { handled: true, reply: context.sessionLocked }
      if (!context.resumeSession) {
        return { handled: true, reply: 'Session switching is not available on this surface.' }
      }
      if (!argument) return { handled: true, reply: 'Usage: /resume <id>. See /sessions for the ids.' }
      const switched = await context.resumeSession(argument)
      return {
        handled: true,
        reply: switched
          ? `Switched to session ${argument}.`
          : `No session "${argument}". See /sessions for the ids.`,
      }
    }

    case 'fork': {
      if (context.sessionLocked) return { handled: true, reply: context.sessionLocked }
      if (!context.forkSession) {
        return { handled: true, reply: 'Session switching is not available on this surface.' }
      }
      const { targetId, upToTurn } = parseForkArgument(argument)
      const result = await context.forkSession(targetId, upToTurn !== undefined ? { upToTurn } : undefined)
      if (!result) {
        return {
          handled: true,
          reply: targetId ? `No session "${targetId}". See /sessions for the ids.` : 'Could not fork session.',
        }
      }
      return {
        handled: true,
        reply: `Branched into new session: ${result.id}. /sessions to list, /resume ${result.id} to come back.`,
      }
    }

    case 'compact': {
      if (!context.compactSession) {
        return { handled: true, reply: 'Compaction is not available on this surface.' }
      }
      return { handled: true, reply: compactReply(await context.compactSession()) }
    }

    case 'stats': {
      if (!context.sessionStats) {
        return { handled: true, reply: 'Session stats are not available on this surface.' }
      }
      return { handled: true, reply: formatStats(await context.sessionStats()) }
    }

    case 'clear':
      await context.resetSession?.()
      return { handled: true, reply: 'Conversation cleared.' }

    case 'skills':
      return { handled: true, reply: formatSkillList(context.skills?.() ?? []) }

    case 'memory': {
      if (context.memoryLocked) return { handled: true, reply: context.memoryLocked }
      if (!context.memories) {
        return { handled: true, reply: 'Memory is not available on this surface.' }
      }
      const asked = argument.trim()
      if (/^forget\b/i.test(asked)) {
        const id = asked.replace(/^forget\b/i, '').trim()
        if (!id) {
          return { handled: true, reply: 'Usage: /memory forget <id>. The ids come from /memory.' }
        }
        const removed = (await context.forgetMemory?.(id)) ?? false
        return {
          handled: true,
          reply: removed
            ? `Forgotten: ${id} — it is out of recall from the next question on.`
            : `Nothing matches "${id}". Run /memory for the ids.`,
        }
      }
      // Twelve, not the whole store: a chat is read on a phone, and the rest is
      // reachable by forgetting a few first.
      return { handled: true, reply: formatMemoryList(await context.memories(12)) }
    }

    case 'export': {
      // An argument it does not know is answered, not ignored: silently writing
      // Markdown because someone typed `xml` is a command doing something other
      // than what it was asked. Checked first, because it needs no session.
      if (argument && argument !== 'md' && argument !== 'json') {
        return {
          handled: true,
          reply: 'Export as what? `/export` for Markdown, `/export json` for the entries themselves.',
        }
      }
      if (!context.sessionStats) return { handled: true, reply: 'This surface cannot export.' }
      const format: ExportFormat = argument === 'json' ? 'json' : 'md'
      const stats = await context.sessionStats()
      const written = await writeSessionExport({ id: stats.id, title: stats.title, format })
      return {
        handled: true,
        reply: written
          ? describeExport(written)
          : `Nothing to export for ${stats.id}: the log has nothing from it yet. A conversation is written out as it runs, so a session that has not had a turn has nothing.`,
      }
    }

    case 'status':
      return {
        handled: true,
        reply:
          context.status ??
          `Permission mode: ${context.policy?.mode ?? 'ask'}. ${describeDisplay(context.display)}` +
            ` · effort: ${context.effort ?? DEFAULT_REASONING_EFFORT}`,
      }

    case 'model': {
      if (context.modelLocked) return { handled: true, reply: context.modelLocked }
      const asked = argument.trim()
      if (!asked) {
        if (!context.models) {
          return { handled: true, reply: 'Listing models is not available on this surface.' }
        }
        const name =
          context.providers?.find((item) => item.id === context.currentProvider)?.name ??
          context.currentProvider ??
          'this provider'
        try {
          return { handled: true, reply: describeModels(name, await context.models(), context.currentModel) }
        } catch (error) {
          return { handled: true, reply: errorMessage(error) }
        }
      }
      if (!context.persistModel) {
        return { handled: true, reply: 'Changing the model is not available on this surface.' }
      }
      // The id is not checked against the catalog: the catalog is a network call,
      // an id it does not list can still be served (a custom endpoint, a model
      // added since the cache), and one that is wrong fails loudly on the turn
      // that uses it — never a quiet fall back to a model nobody asked for.
      try {
        const landed = context.persistModel(asked)
        return { handled: true, reply: `Model: ${landed.model} — now answering with it. Saved for every surface.` }
      } catch (error) {
        return { handled: true, reply: errorMessage(error) }
      }
    }

    case 'setup':
      return {
        handled: true,
        reply: 'Run `milo setup` in a terminal to change the provider, model and keys.',
      }

    default:
      return { handled: true, reply: `Unknown command: /${command}. Try /help` }
  }
}

/**
 * The commands that act on the turn rather than on the session. They cannot go
 * through `handleCommand`, which runs *inside* a queued turn: `/stop` waiting
 * behind the turn it is meant to stop is no stop at all, and `/steer` and
 * `/queue` say where a text goes, which is only decidable before it is queued.
 */
export type TurnControl =
  | { action: 'stop' }
  | { action: 'steer' | 'queue'; text: string }

export function parseTurnControl(raw: string): TurnControl | null {
  if (!raw.startsWith('/')) return null
  const { command, argument } = parse(raw)
  switch (command.toLowerCase()) {
    case 'stop':
      return { action: 'stop' }
    case 'steer':
    case 'queue':
      // An empty argument is not "no command": it is the command without its
      // text, and the reply has to say so rather than fall through to "unknown".
      return { action: command.toLowerCase() as 'steer' | 'queue', text: argument }
    default:
      return null
  }
}

/**
 * What a surface has to be able to do with the turn running now, so that `/stop`,
 * `/steer` and `/queue` mean the same thing in a terminal, on Telegram and on
 * Discord. Each surface binds its own machinery behind this — the bots their
 * `TurnQueue`, the CLI its refs. The vocabulary and the rules are what is shared;
 * only the plumbing is local.
 */
export interface TurnControlTarget {
  /** Hands text to the running turn; false when there is nobody to hand it to. */
  steer(text: string): boolean
  /** True while a turn is running — queued is not running. */
  busy(): boolean
  queued(): number
  stop(): { stopped: boolean; dropped: number }
}

/** One conversation of a `TurnQueue`, as the control commands see it. */
export function turnOf(turns: TurnQueue, key: string): TurnControlTarget {
  return {
    steer: (text) => turns.steer(key, text),
    busy: () => turns.busy(key),
    queued: () => turns.queued(key),
    stop: () => turns.stop(key),
  }
}

export interface TurnControlContext {
  turn: TurnControlTarget
  /**
   * Starts a turn for `text` — the surface's own path, so that a command asking
   * for a turn lands wherever a message asking for one would.
   */
  start: (text: string) => void
}

/** Carries out `/stop`, `/steer` and `/queue` against the turn running now. */
export function handleTurnControl(raw: string, context: TurnControlContext): CommandResult {
  const control = parseTurnControl(raw)
  if (!control) return { handled: false }
  const { turn, start } = context

  switch (control.action) {
    case 'stop': {
      const { stopped, dropped } = turn.stop()
      if (!stopped) return { handled: true, reply: 'Nothing is running to stop.' }
      return {
        handled: true,
        reply:
          dropped === 0
            ? '🛑 Stopped.'
            : `🛑 Stopped — and dropped ${dropped} message${dropped === 1 ? '' : 's'} that ${
                dropped === 1 ? 'was' : 'were'
              } waiting behind it.`,
      }
    }

    case 'steer': {
      if (!control.text) {
        return {
          handled: true,
          reply: 'Usage: /steer <text> — it joins the turn running now, at its next step. Plain text does the same.',
        }
      }
      if (turn.steer(control.text)) {
        return { handled: true, reply: '↳ Handed to the turn running now; it reads it at the next step.' }
      }
      start(control.text)
      return { handled: true, reply: 'Nothing was running, so this is its own turn.' }
    }

    case 'queue': {
      if (!control.text) {
        return {
          handled: true,
          reply: 'Usage: /queue <text> — a turn of its own, after the one running now.',
        }
      }
      const behind = turn.busy()
      start(control.text)
      if (!behind) return { handled: true, reply: 'Nothing was running, so this is running now.' }
      const waiting = turn.queued()
      return {
        handled: true,
        reply: `⏳ Queued behind the turn running now${waiting > 1 ? ` (${waiting} waiting)` : ''}.`,
      }
    }
  }
}

/**
 * What to say about a compaction, in one place: the CLI and the bots must not
 * disagree about whether "nothing to compact" or "dropped without a summary" is
 * the answer the person gets.
 */
export function compactReply(result: CompactResult): string {
  // "Nothing to compact" is an answer, not a failure, and it is the common one: a
  // session younger than `keepTurns` turns has nothing worth folding.
  if (result.reason) return `Nothing to compact: ${result.reason}.`
  const turns = `${result.folded} turn${result.folded === 1 ? '' : 's'}`
  const took = result.ms >= 1000 ? `${(result.ms / 1000).toFixed(1)}s` : `${result.ms}ms`
  return result.summarized
    ? `🗜 Compacted: ${turns} (~${result.tokens} tokens) folded into the summary, in ${took}. /stats for what is left.`
    : `🗜 Compacted: ${turns} (~${result.tokens} tokens) dropped — the summary call failed, so nothing was written in its place. In ${took}.`
}

/** Inline-button payloads: `perm:<id>:allow|deny`. */
export function encodePermission(id: string, allowed: boolean): string {
  return `perm:${id}:${allowed ? 'allow' : 'deny'}`
}

export function decodePermission(data: string): { id: string; allowed: boolean } | null {
  const parts = data.split(':')
  if (parts.length !== 3 || parts[0] !== 'perm') return null
  const id = parts[1]
  const action = parts[2]
  if (!id || (action !== 'allow' && action !== 'deny')) return null
  return { id, allowed: action === 'allow' }
}
