import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import { logDebug } from '../../util/log.js'
import { rulesFile } from '../config/paths.js'
import { effectiveSegment, parseShell } from './shell-parse.js'

/**
 * The rules a person writes down, so a command they trust does not ask every
 * time and one they do not trust is refused before anything runs.
 *
 * Two files: the install's own `~/.milo/rules.yml`, and a project's
 * `<project>/.milo/rules.yml`. The project's are read first and the first rule
 * that matches wins, so a folder can tighten the install's defaults — or relax
 * its own commands — without rewriting the global file.
 *
 * A rule that cannot be read is not a rule that allows: an unreadable file
 * leaves the policy with no `allow` entries at all, which is the conservative
 * answer, and the reason is logged rather than shown to the model.
 */

export interface PermissionRule {
  /** The command glob this rule applies to. Absent means every command. */
  match?: string
  /** The command glob this rule must not match. */
  not_match?: string
  action: 'allow' | 'deny' | 'ask'
  reason?: string
}

export type RuleBook =
  | { kind: 'rules'; rules: PermissionRule[] }
  | { kind: 'absent' }
  | { kind: 'unreadable'; error: string }

const RuleSchema = z.object({
  match: z.string().optional(),
  not_match: z.string().optional(),
  action: z.enum(['allow', 'deny', 'ask']),
  reason: z.string().optional(),
})

const RuleFileSchema = z.object({
  rules: z.array(RuleSchema).max(200),
})

/** The same ceiling the instructions carry: a section of policy, not a database. */
const MAX_RULE_BYTES = 16 * 1024

interface CacheEntry {
  mtimeMs: number
  size: number
  book: RuleBook
}

const cache = new Map<string, CacheEntry>()
const patterns = new Map<string, RegExp>()

/**
 * Reads one rules file. Present, absent or unreadable — the same three outcomes
 * as the instructions, for the same reason: "there are no rules" and "there are
 * rules I could not read" are different things to a policy.
 */
export function readRuleFile(file: string): RuleBook {
  let size: number
  let mtimeMs: number
  try {
    const stats = statSync(file)
    if (!stats.isFile()) return { kind: 'unreadable', error: `${file} is not a file` }
    size = stats.size
    mtimeMs = stats.mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', error: errorMessage(error) }
  }

  const cached = cache.get(file)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.book

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { kind: 'unreadable', error: errorMessage(error) }
  }
  if (size > MAX_RULE_BYTES) {
    return { kind: 'unreadable', error: `${file} is larger than ${MAX_RULE_BYTES} bytes` }
  }
  if (raw.includes('\u0000')) return { kind: 'unreadable', error: `${file} is not a text file` }
  if (raw.trim() === '') return { kind: 'absent' }

  let book: RuleBook
  try {
    const parsed = RuleFileSchema.safeParse(parseYaml(raw) ?? {})
    book = parsed.success
      ? { kind: 'rules', rules: parsed.data.rules }
      : { kind: 'unreadable', error: parsed.error.message }
  } catch (error) {
    book = { kind: 'unreadable', error: errorMessage(error) }
  }

  cache.set(file, { mtimeMs, size, book })
  return book
}

/**
 * The rules that apply to a shell command run from `cwd`: the project's first,
 * then the install's. Read through a stat cache, so an edit is picked up on the
 * next decision and an unchanged file is not parsed again.
 */
export function loadRules(cwd: string, globalFile: string = rulesFile()): RuleBook {
  const global = readRuleFile(globalFile)
  const projectFile = path.join(cwd, '.milo', 'rules.yml')
  // An install whose working directory is `~` would otherwise read the global
  // file twice, once under each name.
  const project = path.resolve(projectFile) === path.resolve(globalFile)
    ? ({ kind: 'absent' } as const)
    : readRuleFile(projectFile)

  const rules = [
    ...(project.kind === 'rules' ? project.rules : []),
    ...(global.kind === 'rules' ? global.rules : []),
  ]
  const errors = [project, global]
    .filter((book): book is Extract<RuleBook, { kind: 'unreadable' }> => book.kind === 'unreadable')
    .map((book) => book.error)

  if (rules.length > 0) {
    // A broken file beside a readable one is worth a line in the debug log, but
    // it must not discard the rules that are understood.
    if (errors.length > 0) logDebug(`some permission rules could not be read: ${errors.join('; ')}`)
    return { kind: 'rules', rules }
  }
  if (errors.length > 0) return { kind: 'unreadable', error: errors.join('; ') }
  return { kind: 'absent' }
}

/**
 * The first rule in the book that matches the command, or undefined.
 *
 * Each command on the line is tested on its own, with `sudo`/`env` peeled off,
 * so `npm test*` matches the `npm test` in `cd app && npm test`. A command the
 * parser cannot read is tested as the raw line: `deny` and `ask` still apply,
 * but `allow` is skipped — unknown never becomes a yes.
 */
export function matchingRule(book: RuleBook, command: string): PermissionRule | undefined {
  if (book.kind !== 'rules') return undefined

  const parsed = parseShell(command)
  const texts = parsed.ok ? parsed.segments.map((segment) => effectiveSegment(segment).text) : [command]

  for (const rule of book.rules) {
    if (rule.action === 'allow' && !parsed.ok) continue
    if (texts.some((text) => ruleMatches(rule, text))) return rule
  }
  return undefined
}

export function ruleMatches(rule: PermissionRule, text: string): boolean {
  if (!commandPattern(rule.match ?? '*').test(text)) return false
  if (rule.not_match && commandPattern(rule.not_match).test(text)) return false
  return true
}

/** A command glob: `*` any run of characters, `?` one, everything else literal. */
export function commandPattern(pattern: string): RegExp {
  const cached = patterns.get(pattern)
  if (cached) return cached

  let source = ''
  for (const char of pattern.trim()) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  const compiled = new RegExp(`^${source}$`)
  patterns.set(pattern, compiled)
  return compiled
}
