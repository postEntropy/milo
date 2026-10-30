import {
  extractCommandText,
  extractTypedText,
  reviewText,
  scanCommand,
  scanCommandTargets,
  scanWriteTarget,
} from './rules.js'
import path from 'node:path'
import { fileChange } from '../change.js'
import { patchTargets } from './apply-patch.js'
import { matchingRule, type RuleBook } from './rule-file.js'
import { effectiveSegment, parseShell } from './shell-parse.js'
import type { Tool } from './types.js'
import { canonicalToolPath } from './walk.js'

export type PermissionDecision = 'allow' | 'ask' | 'deny'
export type PermissionMode = 'ask' | 'auto' | 'yolo'

/**
 * How each mode is named on screen. The stored value is `yolo` — a joke, and not
 * a word to put in front of someone — so what a person reads is this label, and
 * every surface that shows the mode takes it from here rather than inventing one.
 */
export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  ask: 'Ask',
  auto: 'Auto',
  yolo: 'Unrestricted',
}

export interface PermissionRequest {
  tool: string
  args: unknown
  summary: string
}

export interface PermissionResult {
  allowed: boolean
  /**
   * "Always" — the answer also stands for the next call with the same approval
   * key, for the rest of this session. Absent on an ordinary allow.
   */
  remember?: boolean
}

/** Provided by the surface (CLI, Telegram, …) to ask the user inline. */
export type PermissionAsker = (request: PermissionRequest) => Promise<PermissionResult>

/**
 * Whether a call may change something outside Milo — the file it writes, the command it
 * runs. A read-only tool cannot, nor an internal one whose effect stays in Milo's own
 * state, nor a delegating one whose effect is the subtask's own calls. And a tool whose
 * danger lives in its arguments — scheduling a prompt that only reads is not the same act
 * as scheduling one that may run a command — says for itself whether *this* call is the
 * side effect worth asking about.
 *
 * One question, asked in one place: the gate that decides whether to prompt asks it, and
 * so does a surface that draws what a turn changed. A false positive costs a re-read; a
 * false negative leaves someone looking at what was there before.
 */
export function actsOnSomething(tool: Tool<unknown>, args: unknown): boolean {
  if (tool.readOnly || tool.internal || tool.delegates) return false
  return !tool.asksWhen || tool.asksWhen(args)
}

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
  /**
   * The answer for one call. `cwd` is the directory the call is being made from,
   * when the caller knows it: the same words mean a different thing under a
   * project's root than under the install's home, and one policy serves every
   * session in the process.
   */
  decide(
    tool: Tool<unknown>,
    args: unknown,
    options?: { cwd?: string },
  ): PermissionDecision | Promise<PermissionDecision>
}

export interface PermissionPolicyOptions {
  mode?: PermissionMode
  allow?: string[]
  deny?: string[]
  /** Used in `auto` mode to judge the grey zone. */
  reviewer?: DangerReviewer | null
  /** Allow when P(dangerous) is below this. */
  threshold?: number
  /** Resolves a relative write target before it is judged. A caller that knows
   *  where the call is being made from passes it to `decide` instead. */
  cwd?: string
  /**
   * The rules that apply from a directory. Injected so a policy in a test does
   * not read the machine's `~/.milo/rules.yml`; the runtime wires `loadRules`.
   */
  rules?: (cwd: string) => RuleBook
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
  private readonly rules: (cwd: string) => RuleBook
  private threshold: number

  constructor(options: PermissionPolicyOptions = {}) {
    this.mode = options.mode ?? 'ask'
    this.allow = new Set(options.allow ?? [])
    this.deny = new Set(options.deny ?? [])
    this.reviewer = options.reviewer ?? null
    this.threshold = options.threshold ?? DEFAULT_JEV_THRESHOLD
    this.cwd = options.cwd ?? process.cwd()
    // No rule file unless a runtime wired one: a policy built in a test must not
    // read the person's own rules and change what the test is proving.
    this.rules = options.rules ?? (() => ({ kind: 'absent' }))
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

  decide(
    tool: Tool<unknown>,
    args: unknown,
    options?: { cwd?: string },
  ): PermissionDecision | Promise<PermissionDecision> {
    const cwd = options?.cwd ?? this.cwd
    if (this.mode === 'yolo') return 'allow'
    // A denied tool is denied whatever a rule says.
    if (this.deny.has(tool.name)) return 'deny'
    if (!actsOnSomething(tool, args)) return 'allow'

    // The rule file, when the turn is a shell command. A `deny` here outranks a
    // blanket `allow` below; that is the point of writing one down.
    const command = extractCommandText(args)
    const rule = command ? matchingRule(this.rules(cwd), command) : undefined
    if (rule?.action === 'deny') return 'deny'

    // The config's blanket yes, as it has always been. A rule that only asks
    // does not undo it.
    if (this.allow.has(tool.name)) return 'allow'

    // A rule that allows is still held to the acts no rule may allow: a
    // destructive command or a protected path.
    if (rule?.action === 'allow') return barredByRules(args, cwd) ? 'deny' : 'allow'
    if (rule?.action === 'ask') return 'ask'

    if (this.mode === 'ask') return 'ask'

    // The acts the rules bar outright, whatever the mode — judged from where the
    // call is being made, which the caller knows and this object does not.
    if (barredByRules(args, cwd)) return 'deny'

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
 * What an "Always" answer covers.
 *
 * The key is deliberately coarse where a coarse key is safe and refuses where it
 * is not: a shell command is its program and its subcommand (`npm test`, `git
 * status`), a chain gets no key at all (allowing `cd app && …` would allow any
 * command after it), and a write is its directory. An unrecognised tool is its
 * name alone — the whole tool, which is what the person saw the prompt about.
 */
export function approvalKey(tool: string, args: unknown, cwd: string): string | null {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}

  if (tool === 'shell_command') {
    const command = typeof record.command === 'string' ? record.command : ''
    const parsed = parseShell(command)
    // A chain is not one act: `cd app && rm -rf build` and `cd app && npm test`
    // share a first command and not a decision.
    if (!parsed.ok || parsed.segments.length !== 1) return null
    const segment = effectiveSegment(parsed.segments[0]!)
    if (!segment.program) return null
    const subcommand = segment.args.find((arg) => !arg.startsWith('-'))
    return `shell:${[segment.program, subcommand].filter(Boolean).join(' ')}`
  }

  if (tool === 'write_file' || tool === 'edit_file') {
    if (typeof record.path !== 'string' || !record.path.trim()) return null
    return `dir:${path.dirname(canonicalToolPath(cwd, record.path))}`
  }

  if (tool === 'format') {
    // The formatter's subject exactly: a folder and a file in it are different
    // questions, and approving one should not approve the other.
    const subject = typeof record.path === 'string' && record.path.trim()
      ? canonicalToolPath(cwd, record.path)
      : cwd
    return `format:${subject}`
  }

  if (tool === 'apply_patch') {
    if (typeof record.patch !== 'string') return null
    const dirs = [
      ...new Set(patchTargets(record.patch).map((target) => path.dirname(canonicalToolPath(cwd, target)))),
    ].sort()
    return dirs.length > 0 ? `dirs:${dirs.join(',')}` : null
  }

  return `tool:${tool}`
}

/**
 * The policy with a session's "Always" answers layered on. Only a decision that
 * was going to ask can be answered from the cache; a deny stays a deny, and an
 * allow that came from the rules or the config is not made more permissive.
 *
 * A cached yes is still held to the deterministic rules: the person approving
 * `npm test` once did not approve a destructive command that happens to share a
 * key, and `barredByRules` is the backstop that says so.
 */
export function withApprovals(
  policy: PermissionPolicy,
  approved: Set<string>,
  cwd: string,
): PermissionPolicy {
  return {
    get mode(): PermissionMode {
      return policy.mode
    },
    setMode: (mode) => policy.setMode(mode),
    update: (options) => policy.update(options),
    decide: async (tool, args, options) => {
      const decision = await policy.decide(tool, args, options)
      if (decision !== 'ask') return decision
      const key = approvalKey(tool.name, args, options?.cwd ?? cwd)
      if (!key || !approved.has(key)) return decision
      return barredByRules(args, options?.cwd ?? cwd) ? 'deny' : 'allow'
    },
  }
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
    decide: async (tool, args, options) => {
      // The answer is judged from where the call is being made, which the caller
      // knows and this object — the install's, shared by every session in the
      // process — does not. The grant path below already has that directory: it
      // was handed the turn's own when it was built.
      const decision = await policy.decide(tool, args, options)
      if (decision === 'deny') return 'deny'
      if (!granted.includes(tool.name)) return decision
      return barredByRules(args, options?.cwd ?? cwd) ? 'deny' : 'allow'
    },
  }
}

/**
 * Whether a planning turn may keep this tool: it reads, its effect stays inside
 * Milo's own state, or it delegates — and the subtask's own calls pass through the
 * same gate. Everything else is left out of the catalog, so a write is not offered
 * to a turn that has promised not to make one.
 */
export function isPlanTool(tool: Tool<unknown> | undefined): boolean {
  return tool !== undefined && (tool.readOnly === true || tool.internal === true || tool.delegates === true)
}

/**
 * A turn that is planning, not doing: reads stay, and anything that would change
 * something is refused before the policy is even asked.
 *
 * The catalog already leaves the write tools out (see `Session.turn`); this is the
 * backstop for a call that reached the gate anyway — a subagent's own catalog, an
 * MCP tool nobody filtered — and it is what makes the promise in the prompt true
 * rather than merely requested. `delegates` stays allowed: the subtask's own calls
 * pass through this same wrapper, so its writes are refused one level down.
 */
export function withPlan(policy: PermissionPolicy): PermissionPolicy {
  return {
    get mode(): PermissionMode {
      return policy.mode
    },
    setMode: (mode) => policy.setMode(mode),
    update: (options) => policy.update(options),
    decide: (tool, args, options) =>
      actsOnSomething(tool, args) ? 'deny' : policy.decide(tool, args, options),
  }
}

/**
 * What a confirmation prompt shows. For a command: the command — plus the
 * directory, since `cwd` changes what the same words do. For a write: the path
 * *and* the content, because approving a path without seeing what goes in it is
 * not a decision, and the reviewer already gets that; the human who is actually
 * asked was the one left out.
 */
export function summarizeToolCall(args: unknown, tool?: string): string {
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
    // The formatter: where it runs, and whether it writes — checking a file and
    // reformatting it are different questions to approve.
    if (tool === 'format') {
      const where = typeof record.path === 'string' && record.path.trim() ? record.path : 'the changed files'
      return `${record.check === true ? 'Check formatting of' : 'Format'} ${where}`
    }
    if (typeof record.path === 'string') return writePreview(record) ?? record.path
    // A patch across files: every file it touches, then the patch itself — the
    // paths are what the decision is about, and the body is what goes in them.
    if (typeof record.patch === 'string') {
      const files = patchTargets(record.patch)
      const named = files.length > 0 ? `Files: ${files.join(', ')}\n` : ''
      const counts = patchCounts(record.patch)
      return `Apply a patch\n${named}${counts ? `${counts}\n` : ''}${preview(record.patch)}`
    }
    // Acting on one mail message: what is done, and to which one — a prompt that
    // does not say what it will touch is not a decision.
    if (typeof record.op === 'string' && typeof record.id === 'string') {
      const verb: Record<string, string> = {
        archive: 'Archive',
        read: 'Mark read',
        unread: 'Mark unread',
        trash: 'Move to the bin',
      }
      return `${verb[record.op] ?? record.op} message ${record.id}`
    }
    // Mail written in the turn: who it goes to and what it says. A prompt that
    // showed neither would be asking someone to approve a blank.
    if (tool === 'gmail_send' || tool === 'gmail_draft') {
      const to = typeof record.to === 'string' ? record.to.trim() : ''
      const subject = typeof record.subject === 'string' ? record.subject.trim() : ''
      const body = typeof record.body === 'string' ? preview(record.body) : ''
      const verb = tool === 'gmail_draft' ? 'Draft mail to' : 'Send mail to'
      return [`${verb} ${to}`, subject ? `Subject: ${subject}` : '', body].filter(Boolean).join('\n')
    }
    // A rule, and where it lands: the prompt carries it from the next turn on, in
    // every session of that scope — so the rule itself is what is being approved.
    if (tool === 'instructions' && typeof record.text === 'string' && record.text.trim()) {
      const where = record.scope === 'project' ? "this project's AGENTS.md" : '~/.milo/AGENTS.md'
      return record.action === 'remove'
        ? `Remove the rule from ${where}: ${record.text.trim()}`
        : `Write into ${where}, carried by every turn from now on: ${record.text.trim()}`
    }
    // Changing or dropping a routine: the id is what it acts on, and a standing
    // grant is still the half that has to be seen before it is approved. The same
    // shape says a session is being dropped — both carry `action: "remove"` and an
    // id — so the tool's own name is what tells the two apart, and a prompt about a
    // session must not read as one about a routine.
    if (record.action === 'remove') {
      const id = typeof record.id === 'string' ? record.id : ''
      return (tool === 'sessions' ? `Remove session ${id}` : `Remove routine ${id}`).trim()
    }
    if (record.action === 'update') {
      const granted =
        Array.isArray(record.allow) && record.allow.length > 0
          ? `\nUnattended: ${record.allow.join(', ')}`
          : ''
      return `Update routine ${typeof record.id === 'string' ? record.id : ''}${granted}`.trim()
    }
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
    // The change itself, not the two arguments side by side: a snippet that shares
    // most of its lines with the one replacing it reads as a rewrite when it is one
    // edited line, and approving it means seeing which.
    const change = fileChange(target, record.old_string, record.new_string)
    const lines = change.lines.slice(0, PROMPT_DIFF_LINES).map((line) => {
      const mark = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
      return `${mark} ${line.text}`
    })
    if (change.lines.length > PROMPT_DIFF_LINES) lines.push('…')
    return [target, ...lines].join('\n')
  }
  return null
}

/** How much of a change a prompt shows: it sits under a question, not in a page. */
const PROMPT_DIFF_LINES = 20

/** The `+3 −1` a patch would come to, read from its own lines. */
function patchCounts(patch: string): string {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('***')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return [additions > 0 ? `+${additions}` : '', deletions > 0 ? `−${deletions}` : '']
    .filter(Boolean)
    .join(' ')
}

function preview(text: string): string {
  return text.length > SUMMARY_PREVIEW ? `${text.slice(0, SUMMARY_PREVIEW)} …` : text
}
