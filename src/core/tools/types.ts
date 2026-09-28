import type { z } from 'zod'
import type { MemoryInput, MemoryScope } from '../memory/types.js'
import type { OutgoingFile } from '../outgoing.js'
import type { ImageMime } from '../providers/types.js'
import type { NewRoutine, Routine } from '../routines.js'
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

/** How a session hands a tool the ability to add a routine to the install's list. */
export type RoutineFn = (input: NewRoutine) => Promise<Routine>

/**
 * How a session hands a tool the ability to send a file to the chat this turn
 * delivers to. The session owns the destination — a routine's target — and holds
 * what was sent until the turn ends, when the surface posts it.
 */
export type SendFileFn = (input: { path: string; caption?: string }) => Promise<OutgoingFile>

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Absent on a context with no memory behind it, so `remember` fails cleanly. */
  remember?: RememberFn
  /** Absent on a context with no session store behind it, so `recall` does too. */
  recall?: RecallFn
  /** Absent on a context that cannot delegate (a subagent's own, a bare test one). */
  task?: TaskFn
  /**
   * The conversation this turn came from. It is where a routine created in chat
   * delivers by default — and its gateway tells the tool whether there is anyone
   * to deliver to at all.
   */
  origin?: MemoryScope
  /**
   * Absent on a context that cannot make routines. A routine's own run is one of
   * them, so a routine cannot create more routines.
   */
  routine?: RoutineFn
  /**
   * Absent on a context with no chat to send to. Present on a routine's own run,
   * where the destination is the routine's target, so `send_file` reaches the
   * person the routine was made for.
   */
  sendFile?: SendFileFn
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
   * Whether *this* call is the kind of side effect that needs a confirmation.
   * For a tool whose danger lives in its arguments rather than in its name:
   * scheduling a prompt that only reads is not the same act as scheduling one
   * that may run a command. Absent means the flags above are the whole answer.
   */
  asksWhen?(args: A): boolean
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
