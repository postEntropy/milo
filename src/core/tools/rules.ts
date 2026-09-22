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

/**
 * Inside `/dev`, but not somewhere a command writes anything that survives.
 * `> /dev/null` is how half of shell one-liners are written, and refusing it
 * would be the kind of false positive that gets a rule turned off.
 */
const HARMLESS_DEVICES = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
])

export function scanWriteTarget(args: unknown, cwd: string): RuleHit | null {
  const target = extractWriteTarget(args)
  if (!target) return null
  return protectedPath(resolveToolPath(cwd, target))
}

/**
 * The same protection for the shell. A file write was refused outright while
 * `rm -rf ~/.ssh` or `echo key > ~/.ssh/authorized_keys` merely went to the
 * reviewer — the same target, judged by which tool happened to reach it.
 *
 * This reads the command as text, so it is a backstop, not a sandbox: it knows
 * redirections and the handful of commands that take a path to write, and it
 * deliberately ignores everything else. Reading a system file stays fine
 * (`grep … /etc/hosts` is not a write), which is why only these are looked at.
 */
export function scanCommandTargets(command: string, cwd: string): RuleHit | null {
  for (const target of commandWriteTargets(command)) {
    const hit = protectedPath(resolveToolPath(cwd, target))
    if (hit) return hit
  }
  return null
}

/** Commands whose arguments name something to write, and which side of them. */
const WRITE_VERBS: { pattern: RegExp; operands: 'all' | 'last' }[] = [
  { pattern: /\brm\b/, operands: 'all' },
  { pattern: /\btruncate\b/, operands: 'all' },
  { pattern: /\bshred\b/, operands: 'all' },
  { pattern: /\btee\b/, operands: 'all' },
  { pattern: /\bsed\b[^\n;&|]*\s(?:-i|--in-place)\b/, operands: 'all' },
  // Only the last argument is written to, so `cp /etc/hosts ./copy` stays legal.
  { pattern: /\bmv\b/, operands: 'last' },
  { pattern: /\bcp\b/, operands: 'last' },
  { pattern: /\bln\b/, operands: 'last' },
  { pattern: /\binstall\b/, operands: 'last' },
]

function commandWriteTargets(command: string): string[] {
  const targets: string[] = []
  const add = (value: string | undefined): void => {
    const clean = value ? unquote(value) : ''
    if (clean) targets.push(clean)
  }

  // `> file`, `>> file` — but not `2>&1`, whose target is a file descriptor.
  for (const match of command.matchAll(/>>?\s*([^\s;&|<>]+)/g)) add(match[1])

  for (const verb of WRITE_VERBS) {
    const match = verb.pattern.exec(command)
    if (!match) continue
    const rest = command.slice(match.index + match[0].length)
    const segment = rest.split(/[;&|\n]/)[0] ?? ''
    const operands = segment
      .split(/\s+/)
      .filter((token) => token.length > 0 && !token.startsWith('-'))
    for (const token of verb.operands === 'all' ? operands : operands.slice(-1)) add(token)
  }

  for (const match of command.matchAll(/\bdd\b[^\n;&|]*?\bof=([^\s;&|]+)/g)) add(match[1])
  for (const match of command.matchAll(/\b(?:curl|wget)\b[^\n;&|]*?\s(?:-o|--output|-O)\s*([^\s;&|]+)/g)) {
    add(match[1])
  }

  return targets
}

/** The shell would have expanded these; the scan has to as well, or it misses. */
function unquote(token: string): string {
  return token
    .replace(/^["']|["']$/g, '')
    .replace(/\$\{?HOME\}?/g, homedir())
}

function protectedPath(resolved: string): RuleHit | null {
  if (HARMLESS_DEVICES.has(resolved)) return null

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
  if (command) {
    // The directory is part of the action: `rm -rf *` means something else in
    // /etc, and the reviewer has to see which one it is judging.
    const cwd =
      args && typeof args === 'object' && typeof (args as Record<string, unknown>).cwd === 'string'
        ? ((args as Record<string, unknown>).cwd as string).trim()
        : ''
    return cwd ? `Command to run (in ${cwd}):\n${command}` : `Command to run:\n${command}`
  }

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
