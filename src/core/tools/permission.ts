import {
  extractCommandText,
  extractTypedText,
  reviewText,
  scanCommand,
  scanCommandTargets,
  scanWriteTarget,
} from './rules.js'
import type { Tool } from './types.js'

export type PermissionDecision = 'allow' | 'ask' | 'deny'
export type PermissionMode = 'ask' | 'auto' | 'yolo'

export interface PermissionRequest {
  tool: string
  args: unknown
  summary: string
}

export interface PermissionResult {
  allowed: boolean
}

/** Provided by the surface (CLI, Telegram, …) to ask the user inline. */
export type PermissionAsker = (request: PermissionRequest) => Promise<PermissionResult>

/** Returns P(dangerous) in 0..1 for a state string. */
export interface DangerReviewer {
  review(state: string, signal?: AbortSignal): Promise<number>
}

export interface PermissionPolicyUpdate {
  mode?: PermissionMode
  allow?: string[]
  deny?: string[]
  threshold?: number
}

export interface PermissionPolicy {
  readonly mode: PermissionMode
  setMode(mode: PermissionMode): void
  update(options: PermissionPolicyUpdate): void
  decide(tool: Tool<unknown>, args: unknown): PermissionDecision | Promise<PermissionDecision>
}

export interface PermissionPolicyOptions {
  mode?: PermissionMode
  allow?: string[]
  deny?: string[]
  /** Used in `auto` mode to judge the grey zone. */
  reviewer?: DangerReviewer | null
  /** Allow when P(dangerous) is below this. */
  threshold?: number
  /** Resolves a relative write target before it is judged. */
  cwd?: string
}

export const DEFAULT_JEV_THRESHOLD = 0.35

/**
 * - `ask`   — read-only is allowed, deny-list blocks, everything else asks.
 * - `auto`  — read-only is allowed, deny-list and the deterministic rules block,
 *             and the grey zone is judged by the reviewer (below threshold →
 *             allow, otherwise ask). Fails closed when the reviewer errors.
 * - `yolo`  — everything is allowed, no prompts.
 */
export class DefaultPermissionPolicy implements PermissionPolicy {
  mode: PermissionMode
  private allow: Set<string>
  private deny: Set<string>
  private readonly reviewer: DangerReviewer | null
  private readonly cwd: string
  private threshold: number

  constructor(options: PermissionPolicyOptions = {}) {
    this.mode = options.mode ?? 'ask'
    this.allow = new Set(options.allow ?? [])
    this.deny = new Set(options.deny ?? [])
    this.reviewer = options.reviewer ?? null
    this.threshold = options.threshold ?? DEFAULT_JEV_THRESHOLD
    this.cwd = options.cwd ?? process.cwd()
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  /** Applies live edits from the settings screen without rebuilding the runtime. */
  update(options: PermissionPolicyUpdate): void {
    if (options.mode) this.mode = options.mode
    if (options.allow) this.allow = new Set(options.allow)
    if (options.deny) this.deny = new Set(options.deny)
    if (typeof options.threshold === 'number') this.threshold = options.threshold
  }

  decide(tool: Tool<unknown>, args: unknown): PermissionDecision | Promise<PermissionDecision> {
    if (this.mode === 'yolo') return 'allow'
    if (this.deny.has(tool.name)) return 'deny'
    if (tool.readOnly || tool.internal || tool.delegates) return 'allow'
    // A tool whose danger lives in its arguments — scheduling a prompt that only
    // reads is not the same act as scheduling one that may run a command. It says
    // for itself whether *this* call is the side effect worth asking about.
    if (tool.asksWhen && !tool.asksWhen(args)) return 'allow'
    if (this.allow.has(tool.name)) return 'allow'
    if (this.mode === 'ask') return 'ask'

    // The acts the rules bar outright, whatever the mode.
    if (barredByRules(args, this.cwd)) return 'deny'

    if (!this.reviewer) return 'ask'
    const state = reviewText(args)
    if (!state) return 'ask'
    return this.review(state)
  }

  private async review(state: string): Promise<PermissionDecision> {
    try {
      const probability = await this.reviewer!.review(state)
      return probability < this.threshold ? 'allow' : 'ask'
    } catch {
      return 'ask'
    }
  }
}

/** How much of a written file or a replacement is shown before it is approved. */
const SUMMARY_PREVIEW = 400

/**
 * The acts the deterministic rules bar whatever the mode: a destructive command,
 * or a write into a protected path. Shared, so the same words are refused whether
 * they are judged in `auto` or carried into an unattended run by a job's grant.
 */
export function barredByRules(args: unknown, cwd: string): boolean {
  const command = extractCommandText(args)
  // The shell reaches the same protected paths as a file write, so it is held to
  // the same rule instead of being judged differently for the same act.
  if (command && (scanCommand(command) || scanCommandTargets(command, cwd))) return true
  // The same words typed onto a screen run the same way as they would in a shell.
  const typed = extractTypedText(args)
  if (typed && scanCommand(typed)) return true
  return scanWriteTarget(args, cwd) !== null
}

/**
 * The install's policy with a job's standing grants layered on, for a run with
 * nobody to ask.
 *
 * A grant means "this tool may be used unattended" — decided by the person when
 * the job was created, where they could see what they were approving. It is not
 * "anything goes": an explicit deny still denies, and the rules above still bar a
 * destructive command or a protected path, because granting a tool is not the
 * same as granting every use of it. Anything not granted keeps the policy's own
 * answer, which — with no asker on the other end — is a denial.
 */
export function withGrants(
  policy: PermissionPolicy,
  granted: string[],
  cwd: string,
): PermissionPolicy {
  // Nothing to layer on under yolo: the install already answers "allow" to
  // everything, and a job runs in the mode of the person who made it. Checking
  // here rather than in `decide` is what keeps a grant from being *more*
  // restrictive than no grant — under yolo, `barredByRules` is off for everyone.
  if (granted.length === 0 || policy.mode === 'yolo') return policy
  return {
    get mode(): PermissionMode {
      return policy.mode
    },
    setMode: (mode) => policy.setMode(mode),
    update: (options) => policy.update(options),
    decide: async (tool, args) => {
      const decision = await policy.decide(tool, args)
      if (decision === 'deny') return 'deny'
      if (!granted.includes(tool.name)) return decision
      return barredByRules(args, cwd) ? 'deny' : 'allow'
    },
  }
}

/**
 * What a confirmation prompt shows. For a command: the command — plus the
 * directory, since `cwd` changes what the same words do. For a write: the path
 * *and* the content, because approving a path without seeing what goes in it is
 * not a decision, and the reviewer already gets that; the human who is actually
 * asked was the one left out.
 */
export function summarizeToolCall(args: unknown): string {
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>
    if (typeof record.command === 'string') {
      const cwd = typeof record.cwd === 'string' ? record.cwd.trim() : ''
      return cwd ? `cd ${cwd} && ${record.command}` : record.command
    }
    if (typeof record.query === 'string') return record.query
    // A commit: what will be said, and what is being staged with it — approving
    // a commit without seeing either is not a decision.
    if (typeof record.message === 'string' && record.message.trim()) {
      const staging =
        Array.isArray(record.files) && record.files.length > 0
          ? `\nStaging: ${record.files.join(', ')}`
          : record.all === true
            ? '\nStaging: every tracked change'
            : ''
      return `${record.message.trim()}${staging}`
    }
    if (typeof record.path === 'string') return writePreview(record) ?? record.path
    // A routine: what will be run, and what it may touch with nobody there —
    // approving one without seeing either is not a decision.
    if (typeof record.prompt === 'string' && (record.every !== undefined || record.at !== undefined)) {
      const when = typeof record.at === 'string' ? `at ${record.at}` : `every ${String(record.every)}`
      const granted =
        Array.isArray(record.allow) && record.allow.length > 0
          ? `\nUnattended: ${record.allow.join(', ')}`
          : ''
      return `Routine ${when}: ${preview(record.prompt)}${granted}`
    }
  }
  try {
    const json = JSON.stringify(args)
    return json.length > 120 ? `${json.slice(0, 117)}…` : json
  } catch {
    return String(args)
  }
}

function writePreview(record: Record<string, unknown>): string | null {
  const target = record.path as string
  if (typeof record.content === 'string') {
    return `${target}\nNew content:\n${preview(record.content)}`
  }
  if (typeof record.old_string === 'string' && typeof record.new_string === 'string') {
    return [
      target,
      `- ${preview(record.old_string)}`,
      `+ ${preview(record.new_string)}`,
    ].join('\n')
  }
  return null
}

function preview(text: string): string {
  return text.length > SUMMARY_PREVIEW ? `${text.slice(0, SUMMARY_PREVIEW)} …` : text
}
