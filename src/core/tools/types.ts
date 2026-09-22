import type { z } from 'zod'

export interface ToolContext {
  cwd: string
  signal: AbortSignal
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
  execute(args: A, ctx: ToolContext): Promise<ToolResult>
}
