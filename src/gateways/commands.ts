import { formatSessionList, formatStats } from '../core/sessions/index.js'
import type { SessionStats, SessionSummary } from '../core/sessions/index.js'
import { formatSkillList, type SkillSummary } from '../core/skills/index.js'
import { DEFAULT_DISPLAY, type DisplayConfig } from '../core/config/schema.js'
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../core/providers/types.js'
import type { PermissionMode, PermissionPolicy } from '../core/tools/permission.js'

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
  /** The skills installed on this machine, for `/skills`. */
  skills?: () => SkillSummary[]
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
  '/skills — the skills installed, and where they live',
  '/clear — forget this conversation',
  '/status — permission mode and display settings',
  '/help — this message',
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
