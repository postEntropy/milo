import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { ToolSpec } from '../providers/types.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<unknown>>()

  constructor(tools: Tool<unknown>[] = []) {
    for (const tool of tools) this.register(tool)
  }

  register(tool: Tool<unknown>): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool<unknown> | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): Tool<unknown>[] {
    return [...this.tools.values()]
  }

  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.schema),
    }))
  }

  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true }

    const parsed = tool.schema.safeParse(args ?? {})
    if (!parsed.success) {
      return { content: `Invalid arguments for ${name}: ${parsed.error.message}`, isError: true }
    }

    try {
      return await tool.execute(parsed.data, ctx)
    } catch (error) {
      return { content: `Tool ${name} failed: ${errorMessage(error)}`, isError: true }
    }
  }
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json
}
