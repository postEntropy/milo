import type { PermissionMode, PermissionPolicy } from '../core/tools/permission.js'

export interface CommandContext {
  policy?: PermissionPolicy
  resetSession?: () => void
  status?: string
  /** Writes the new mode to disk, so it survives a restart. */
  persistMode?: (mode: PermissionMode) => void
  /** Set when this surface is not allowed to change the mode; used as the reply. */
  modeLocked?: string
}

export interface CommandResult {
  handled: boolean
  reply?: string
}

const HELP = [
  'Commands:',
  '/mode ask|auto|yolo — permission mode, saved for every surface',
  '/yolo — toggle yolo mode',
  '/clear — forget this conversation',
  '/status — current permission mode',
  '/help — this message',
  'Provider, model and keys: run `milo setup` in a terminal.',
].join('\n')

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

/** Applies a mode change to the running policy and to disk. */
function applyMode(context: CommandContext, mode: PermissionMode): void {
  context.policy?.setMode(mode)
  context.persistMode?.(mode)
}

/** Handles the non-interactive slash commands shared by the bot gateways. */
export function handleCommand(raw: string, context: CommandContext): CommandResult {
  if (!raw.startsWith('/')) return { handled: false }

  const [command, argument] = raw.slice(1).split(/\s+/)

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

    case 'clear':
      context.resetSession?.()
      return { handled: true, reply: 'Conversation cleared.' }

    case 'status':
      return { handled: true, reply: context.status ?? `Permission mode: ${context.policy?.mode ?? 'ask'}` }

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
