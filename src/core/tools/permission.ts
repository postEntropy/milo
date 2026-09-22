import { extractCommandText, scanCommand } from './rules.js'
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
  decide(tool: Tool<any>, args: unknown): PermissionDecision | Promise<PermissionDecision>
}

export interface PermissionPolicyOptions {
  mode?: PermissionMode
  allow?: string[]
  deny?: string[]
  /** Used in `auto` mode to judge the grey zone. */
  reviewer?: DangerReviewer | null
  /** Allow when P(dangerous) is below this. */
  threshold?: number
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
  private threshold: number

  constructor(options: PermissionPolicyOptions = {}) {
    this.mode = options.mode ?? 'ask'
    this.allow = new Set(options.allow ?? [])
    this.deny = new Set(options.deny ?? [])
    this.reviewer = options.reviewer ?? null
    this.threshold = options.threshold ?? DEFAULT_JEV_THRESHOLD
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

  decide(tool: Tool<any>, args: unknown): PermissionDecision | Promise<PermissionDecision> {
    if (this.mode === 'yolo') return 'allow'
    if (this.deny.has(tool.name)) return 'deny'
    if (tool.readOnly) return 'allow'
    if (this.allow.has(tool.name)) return 'allow'
    if (this.mode === 'ask') return 'ask'

    const command = extractCommandText(args)
    if (!command) return 'ask'

    const hit = scanCommand(command)
    if (hit) return 'deny'

    if (!this.reviewer) return 'ask'
    return this.review(command)
  }

  private async review(command: string): Promise<PermissionDecision> {
    try {
      const probability = await this.reviewer!.review(`Command to run:\n${command}`)
      return probability < this.threshold ? 'allow' : 'ask'
    } catch {
      return 'ask'
    }
  }
}

export function summarizeToolCall(tool: string, args: unknown): string {
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>
    if (typeof record.command === 'string') return record.command
    if (typeof record.query === 'string') return record.query
    if (typeof record.path === 'string') return record.path
  }
  try {
    const json = JSON.stringify(args)
    return json.length > 120 ? `${json.slice(0, 117)}…` : json
  } catch {
    return String(args)
  }
}
