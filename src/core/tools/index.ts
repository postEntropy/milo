import type { SearchProvider } from '../search/index.js'
import type { SkillLibrary } from '../skills/index.js'
import type { BrowserSession } from '../browser/index.js'
import { createBrowserTools } from '../browser/index.js'
import type { GoogleAccount } from '../config/schema.js'
import type { McpServers } from '../mcp/servers.js'
import { editFileTool } from './edit-file.js'
import { createGmailTools } from './gmail.js'
import { createDriveTools } from './drive.js'
import { fetchUrlTool } from './fetch-url.js'
import { gitCommitTool, gitTool } from './git.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { listDirTool } from './list-dir.js'
import { readFileTool } from './read-file.js'
import { recallTool } from './recall.js'
import { rememberTool } from './remember.js'
import { panelTool } from './panel.js'
import { routineTool } from './routine.js'
import { searchHistoryTool } from './search-history.js'
import { sendFileTool } from './send-file.js'
import { ToolRegistry } from './registry.js'
import { shellTool } from './shell.js'
import { createReadSkillTool } from './read-skill.js'
import { taskTool } from './task.js'
import { todoTool } from './todo.js'
import { taskListsTool } from './task-lists.js'
import type { Tool } from './types.js'
import { createWebSearchTool } from './web-search.js'
import { writeFileTool } from './write-file.js'

export * from './types.js'
export * from './permission.js'
export * from './rules.js'
export { ToolRegistry } from './registry.js'
export { readFileTool } from './read-file.js'
export { listDirTool } from './list-dir.js'
export { globTool } from './glob.js'
export { grepTool } from './grep.js'
export { fetchUrlTool } from './fetch-url.js'
export { gitTool, gitCommitTool } from './git.js'
export { writeFileTool } from './write-file.js'
export { editFileTool } from './edit-file.js'
export { rememberTool } from './remember.js'
export { recallTool } from './recall.js'
export { panelTool } from './panel.js'
export { routineTool } from './routine.js'
export { searchHistoryTool } from './search-history.js'
export { sendFileTool } from './send-file.js'
export { shellTool } from './shell.js'
export { taskTool } from './task.js'
export { todoTool } from './todo.js'
export { taskListsTool } from './task-lists.js'
export { createWebSearchTool } from './web-search.js'
export { createReadSkillTool } from './read-skill.js'
export { Classifier, createClassifier, dangerousReviewer } from '../classifier/index.js'
export type { ClassifierQuestion, ClassifierAnswers, ClassifierOptions } from '../classifier/index.js'

export const builtinTools = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  fetchUrlTool,
  gitTool,
  gitCommitTool,
  writeFileTool,
  editFileTool,
  rememberTool,
  recallTool,
  searchHistoryTool,
  routineTool,
  sendFileTool,
  panelTool,
  taskTool,
  todoTool,
  taskListsTool,
  shellTool,
]

/**
 * The Google tool names, for the surfaces that say what a connection bought.
 *
 * Taken from the factories that will actually answer rather than typed out again,
 * so a line like `milo google status` cannot go on naming one service after the
 * grant has grown another.
 */
export function googleToolNames(account: GoogleAccount | null): string[] {
  return [...createGmailTools(account), ...createDriveTools(account)].map((tool) => tool.name)
}

export interface ToolRegistryOptions {
  search?: SearchProvider | null
  /** The skills directory, live; `read_skill` is only registered when it holds one. */
  skills?: SkillLibrary
  /** The browser, when one is configured — its three tools ride along with it. */
  browser?: BrowserSession | null
  /**
   * Google, when the config asks for it. Registered even with a null account:
   * the tools then answer "not connected, run `milo google connect`", which is a
   * thing the person can act on — an absent tool is only a silence.
   */
  google?: { account: GoogleAccount | null } | null
  /**
   * The external servers, when any are configured. What is registered from them
   * is the cache of what they last said — the connection is the manager's own
   * business, started in the background and never waited for here.
   */
  mcp?: McpServers | null
}

/**
 * `web_search` is only registered when a search provider is configured, and
 * `skill` only when a skill is found at startup — the model never sees a tool it
 * has nothing to use on. The browser tools follow the same rule: off in the
 * config means absent from the catalog, not present and failing.
 *
 * What the registry is handed for skills is the library, not a list: which skills
 * exist is answered when the tool is called, so one installed while Milo runs is
 * served from the next turn on.
 */
export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const tools: Tool<unknown>[] = [...builtinTools]
  if (options.search) tools.push(createWebSearchTool(options.search))
  if (options.skills && options.skills.list().length > 0) tools.push(createReadSkillTool(options.skills))
  if (options.browser) tools.push(...createBrowserTools(options.browser))
  if (options.google) {
    tools.push(...createGmailTools(options.google.account))
    tools.push(...createDriveTools(options.google.account))
  }
  const registry = new ToolRegistry(tools)
  // Added after the built-ins, so the cache the servers bring lands in a registry
  // that already holds everything Milo ships. No name can collide anyway: every
  // MCP tool is prefixed `mcp__`.
  options.mcp?.register(registry)
  return registry
}
