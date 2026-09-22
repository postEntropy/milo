import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveToolPath } from './walk.js'

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

/**
 * The file a call would write, when the call carries content to write. Keyed on
 * the shape of the arguments rather than the tool name, like
 * `extractCommandText` — a tool that writes is a tool that passes `content`, or
 * a replacement pair.
 */
export function extractWriteTarget(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  if (typeof record.path !== 'string' || !record.path.trim()) return null
  const writes =
    typeof record.content === 'string' ||
    (typeof record.old_string === 'string' && typeof record.new_string === 'string')
  return writes ? record.path.trim() : null
}

/** Where an agent has no business writing, whatever it was asked to do. */
const SYSTEM_ROOTS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/System', '/dev']

/** Credential stores. Rewriting one is how a helpful agent leaks your keys. */
const SECRET_ROOTS = ['.ssh', '.gnupg', '.aws', '.netrc', '.docker/config.json', '.kube/config']

export function scanWriteTarget(args: unknown, cwd: string): RuleHit | null {
  const target = extractWriteTarget(args)
  if (!target) return null
  const resolved = resolveToolPath(cwd, target)

  for (const root of SYSTEM_ROOTS) {
    if (isInside(resolved, root)) return { rule: 'write-system-path', reason: `writes inside ${root}` }
  }
  for (const rel of SECRET_ROOTS) {
    if (isInside(resolved, join(homedir(), rel))) {
      return { rule: 'write-secret-store', reason: `writes to ${rel}, a credential store` }
    }
  }
  return null
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)
}

const REVIEW_PREVIEW = 500

/**
 * The state string a danger reviewer should judge, or null when the call has
 * nothing worth judging. A shell command is judged as itself; a file write is
 * judged by its target and the content it is about to replace it with, since
 * that is where the risk actually is.
 */
export function reviewText(args: unknown): string | null {
  const command = extractCommandText(args)
  if (command) return `Command to run:\n${command}`

  const target = extractWriteTarget(args)
  if (!target) return null
  const record = args as Record<string, unknown>

  if (typeof record.content === 'string') {
    return `Write a file:\n${target}\nNew content:\n${preview(record.content)}`
  }
  return [
    `Edit a file:\n${target}`,
    `Replacing:\n${preview(String(record.old_string))}`,
    `With:\n${preview(String(record.new_string))}`,
  ].join('\n')
}

function preview(text: string): string {
  return text.length > REVIEW_PREVIEW ? `${text.slice(0, REVIEW_PREVIEW)}\n… (truncated)` : text
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
