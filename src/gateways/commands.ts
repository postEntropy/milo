import { describeExport, writeSessionExport, type ExportFormat } from '../core/export.js'
import { formatSessionList, formatStats, formatWhen } from '../core/sessions/index.js'
import type { CompactResult, SessionStats, SessionSummary } from '../core/sessions/index.js'
import { formatSkillList, type SkillSummary } from '../core/skills/index.js'
import { DEFAULT_DISPLAY, type DisplayConfig } from '../core/config/schema.js'
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../core/providers/types.js'
import type { PermissionMode, PermissionPolicy } from '../core/tools/permission.js'
import type { MemoryItem } from '../core/memory/index.js'
import type { TurnQueue } from './turns.js'

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
  /** Starts a fresh session and binds it to this conversation. */
  newSession?: (title?: string) => Promise<{ id: string }>
  /** Binds this conversation to an existing session. */
  resumeSession?: (id: string) => Promise<boolean>
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
}

const HELP = [
  'Commands:',
  '/mode ask|auto|yolo — permission mode, saved for every surface',
  '/yolo — toggle yolo mode',
  '/tools full|name|off — how much of each tool call to show',
  '/thinking on|off — show the model\'s reasoning (display only; /effort is what changes how it thinks)',
  "/effort low|medium|high — how hard the model thinks (the one that costs)",
  '/new [title] — start a new session',
  '/sessions — list saved sessions',
  '/resume <id> — switch to another session',
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
  'Provider, model and keys: run `milo setup` in a terminal.',
].join('\n')

const TOOL_LEVELS = ['full', 'name', 'off'] as const

function describeDisplay(display: DisplayConfig | undefined): string {
  const settings = display ?? DEFAULT_DISPLAY
  return `Tools: ${settings.tools} · thinking display: ${settings.thinking}`
}

/**
 * A bot that answers several people must not let one of them turn off
 * confirmations for the others. An empty allowlist means anyone, which is the
 * most exposed case of all, so only a single-person bot may switch.
 */
export function modeLockMessage(allowlist: string[] | undefined): string | undefined {
  const count = allowlist?.length ?? 0
  if (count === 1) return undefined
  return count === 0
    ? '🔒 /mode is locked while this bot answers anyone. Add your id in `milo setup` → Gateways, or set the mode there.'
    : `🔒 /mode is locked while this bot answers ${count} ids. Set the mode in \`milo setup\` on the terminal.`
}

/**
 * Display settings are one value for the whole install, so on a bot that
 * answers several people one of them would be changing what the others see.
 * Same rule as `/mode`: only a single-person bot may do it from the chat.
 */
export function displayLockMessage(allowlist: string[] | undefined): string | undefined {
  const count = allowlist?.length ?? 0
  if (count === 1) return undefined
  return count === 0
    ? '🔒 /tools and /thinking are locked while this bot answers anyone. Set them in `milo setup` → Display.'
    : `🔒 /tools and /thinking are locked while this bot answers ${count} ids. Set them in \`milo setup\` → Display.`
}

/**
 * How hard the model thinks is one value for the whole install, and it is what
 * an answer costs — a bill one person raises for everybody. Locked by the same
 * rule as `/mode`: only a bot that answers one person may change it.
 */
export function effortLockMessage(allowlist: string[] | undefined): string | undefined {
  const count = allowlist?.length ?? 0
  if (count === 1) return undefined
  return count === 0
    ? '🔒 /effort is locked while this bot answers anyone. Set it in `milo setup` → Display, on the terminal.'
    : `🔒 /effort is locked while this bot answers ${count} ids. Set it in \`milo setup\` → Display on the terminal.`
}

/**
 * Sessions are per-person: on a bot that answers several people (or anyone),
 * letting one of them list or switch sessions would expose the others'.
 */
export function sessionLockMessage(allowlist: string[] | undefined): string | undefined {
  const count = allowlist?.length ?? 0
  if (count === 1) return undefined
  return count === 0
    ? '🔒 /new, /sessions and /resume are locked while this bot answers anyone. Add your id in `milo setup` → Gateways.'
    : `🔒 /new, /sessions and /resume are locked while this bot answers ${count} ids. Manage sessions from the CLI.`
}

/**
 * Memory is one store for the whole install, so on a bot that answers several
 * people one of them could read — or delete — what the owner told Milo
 * elsewhere. Same rule as `/sessions`: one person, or the terminal.
 */
export function memoryLockMessage(allowlist: string[] | undefined): string | undefined {
  const count = allowlist?.length ?? 0
  if (count === 1) return undefined
  return count === 0
    ? '🔒 /memory is locked while this bot answers anyone. Run it in the terminal.'
    : `🔒 /memory is locked while this bot answers ${count} ids. Run it in the terminal.`
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
      const sessions = await context.listSessions()
      return {
        handled: true,
        reply: formatSessionList(sessions),
        markdown: formatSessionList(sessions, { markdown: true }),
      }
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

    case 'model':
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
