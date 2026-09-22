import type { SearchProvider } from '../search/index.js'
import { readFileTool } from './read-file.js'
import { ToolRegistry } from './registry.js'
import { shellTool } from './shell.js'
import type { Tool } from './types.js'
import { createWebSearchTool } from './web-search.js'

export * from './types.js'
export * from './permission.js'
export * from './rules.js'
export { ToolRegistry } from './registry.js'
export { readFileTool } from './read-file.js'
export { shellTool } from './shell.js'
export { createWebSearchTool } from './web-search.js'
export { JevReviewer, createJevReviewer } from './jev.js'

export const builtinTools = [readFileTool, shellTool]

export interface ToolRegistryOptions {
  search?: SearchProvider | null
}

/** `web_search` is only registered when a search provider is configured. */
export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const tools: Tool<any>[] = [...builtinTools]
  if (options.search) tools.push(createWebSearchTool(options.search))
  return new ToolRegistry(tools)
}
