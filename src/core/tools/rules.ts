export interface RuleHit {
  rule: string
  reason: string
}

interface Rule {
  rule: string
  pattern: RegExp
  reason: string
}

/**
 * Deterministic, instant, offline checks for commands that are catastrophic or
 * obviously destructive. This is a backstop for the obvious cases; it is not a
 * general-purpose judge (that is what the grey-zone reviewer is for).
 */
const RULES: Rule[] = [
  {
    rule: 'fork-bomb',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'fork bomb',
  },
  { rule: 'mkfs', pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: 'formats a filesystem' },
  {
    rule: 'dd-to-device',
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|vd|mmcblk)/,
    reason: 'writes raw data to a disk device',
  },
  {
    rule: 'redirect-to-device',
    pattern: />\s*\/dev\/(sd|nvme|hd|vd|mmcblk)/,
    reason: 'overwrites a disk device',
  },
  {
    rule: 'chmod-root',
    pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/,
    reason: 'makes the filesystem root world-writable',
  },
  {
    rule: 'pipe-to-shell',
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?([a-z]*sh|python[0-9.]*|perl|ruby)\b/,
    reason: 'pipes downloaded content straight into a shell',
  },
  {
    rule: 'power',
    pattern: /\b(shutdown|reboot|poweroff|halt)\b/,
    reason: 'powers off or restarts the machine',
  },
]

const DESTRUCTIVE_TARGETS = new Set([
  '/',
  '/*',
  '~',
  '~/',
  '~/*',
  '$HOME',
  '$HOME/',
  '$HOME/*',
  '/home',
  '/etc',
  '/usr',
  '/var',
  '/bin',
  '/boot',
])

export function scanCommand(command: string): RuleHit | null {
  const normalized = command.replace(/\s+/g, ' ').trim()

  for (const rule of RULES) {
    if (rule.pattern.test(normalized)) return { rule: rule.rule, reason: rule.reason }
  }

  return findDestructiveRm(normalized)
}

export function extractCommandText(args: unknown): string | null {
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>
    if (typeof record.command === 'string' && record.command.trim()) return record.command
  }
  return null
}

function findDestructiveRm(command: string): RuleHit | null {
  for (const match of command.matchAll(/\brm\s+([^\n;&|]+)/g)) {
    const segments = (match[1] ?? '').trim().split(/\s+/).filter(Boolean)
    const flags = segments.filter((segment) => segment.startsWith('-')).join('')
    const recursive = flags.includes('r') || flags.includes('R') || segments.includes('--recursive')
    if (!recursive) continue

    const force = flags.includes('f') || segments.includes('--force')
    for (const target of segments.filter((segment) => !segment.startsWith('-'))) {
      const cleaned = target.replace(/^["']|["']$/g, '')
      if (DESTRUCTIVE_TARGETS.has(cleaned)) {
        return {
          rule: 'rm-destructive',
          reason: `recursively deletes ${cleaned}${force ? ' (forced)' : ''}`,
        }
      }
    }
  }
  return null
}
