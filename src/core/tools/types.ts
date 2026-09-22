import type { z } from 'zod'
import type { MemoryInput } from '../memory/types.js'

/**
 * How a session hands a tool the ability to write to its memory. Injected
 * through the context because the memory instance and its scope belong to the
 * session, not to the registry that builds the tools.
 */
export type RememberFn = (items: MemoryInput[]) => Promise<void>

export interface ToolContext {
  cwd: string
  signal: AbortSignal
  /** Absent on a context with no memory behind it, so `remember` fails cleanly. */
  remember?: RememberFn
}

export interface ToolResult {
  content: string
  isError?: boolean
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
  execute(args: A, ctx: ToolContext): Promise<ToolResult>
}
