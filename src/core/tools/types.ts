import type { z } from 'zod'
import type { MemoryInput } from '../memory/types.js'
import type { ImageMime } from '../providers/types.js'
import type { SessionSummary } from '../sessions/types.js'

/**
 * How a session hands a tool the ability to write to its memory. Injected
 * through the context because the memory instance and its scope belong to the
 * session, not to the registry that builds the tools.
 */
export type RememberFn = (items: MemoryInput[]) => Promise<void>

/** The same, for looking a past conversation back up by what it was about. */
export type RecallFn = (query: string, opts?: { limit?: number }) => Promise<SessionSummary[]>

/**
 * Runs a subtask in its own agent loop — its own transcript, its own tool
 * calls — and returns only what it finally answers. Delegation is one level:
 * the context handed to the subagent carries no `task` of its own.
 */
export type TaskFn = (input: { description: string; prompt: string }) => Promise<ToolResult>

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Absent on a context with no memory behind it, so `remember` fails cleanly. */
  remember?: RememberFn
  /** Absent on a context with no session store behind it, so `recall` does too. */
  recall?: RecallFn
  /** Absent on a context that cannot delegate (a subagent's own, a bare test one). */
  task?: TaskFn
}

/**
 * A picture a tool wants the model to see — a screenshot, say. Handed over as
 * base64 from wherever it came, and written to disk by the agent loop: that is
 * what keeps a session file small and keeps old pictures out of later requests.
 */
export interface ToolImage {
  mimeType: ImageMime
  /** Base64, exactly as the source emitted it. */
  data: string
}

export interface ToolResult {
  content: string
  isError?: boolean
  images?: ToolImage[]
}

export interface Tool<A = unknown> {
  name: string
  description: string
  schema: z.ZodType<A>
  /** Read-only tools never need confirmation; anything with side effects does by default. */
  readOnly?: boolean
  /**
   * A side effect that stays inside Milo's own state — its memory store, not the
   * user's files or machine. Never asks: prompting to save a note would make
   * saving one not worth doing.
   */
  internal?: boolean
  /**
   * The tool's own effect is to hand work to a subagent, whose individual tool
   * calls are each put to the same policy. So it needs no confirmation of its
   * own: prompting for the delegation and then again for the write it leads to
   * asks the same question twice, and the second prompt is the one that shows
   * what is actually being done.
   */
  delegates?: boolean
  execute(args: A, ctx: ToolContext): Promise<ToolResult>
}
