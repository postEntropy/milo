import type { SearchProvider } from '../search/index.js'
import type { Skill } from '../skills/index.js'
import type { BrowserSession } from '../browser/index.js'
import { createBrowserTools } from '../browser/index.js'
import type { GoogleAccount } from '../config/schema.js'
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
import { routineTool } from './routine.js'
import { searchHistoryTool } from './search-history.js'
import { sendFileTool } from './send-file.js'
import { ToolRegistry } from './registry.js'
import { shellTool } from './shell.js'
import { createReadSkillTool } from './read-skill.js'
import { taskTool } from './task.js'
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
export { routineTool } from './routine.js'
export { searchHistoryTool } from './search-history.js'
export { sendFileTool } from './send-file.js'
export { shellTool } from './shell.js'
export { taskTool } from './task.js'
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
  taskTool,
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
  /** Skills found at startup; `skill` is only registered when there are any. */
  skills?: Skill[]
  /** The browser, when one is configured — its three tools ride along with it. */
  browser?: BrowserSession | null
  /**
   * Google, when the config asks for it. Registered even with a null account:
   * the tools then answer "not connected, run `milo google connect`", which is a
   * thing the person can act on — an absent tool is only a silence.
   */
  google?: { account: GoogleAccount | null } | null
}

/**
 * `web_search` is only registered when a search provider is configured, and
 * `skill` only when a skill was found — the model never sees a tool it has
 * nothing to use on. The browser tools follow the same rule: off in the config
 * means absent from the catalog, not present and failing.
 */
export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const tools: Tool<unknown>[] = [...builtinTools]
  if (options.search) tools.push(createWebSearchTool(options.search))
  if (options.skills && options.skills.length > 0) tools.push(createReadSkillTool(options.skills))
  if (options.browser) tools.push(...createBrowserTools(options.browser))
  if (options.google) {
    tools.push(...createGmailTools(options.google.account))
    tools.push(...createDriveTools(options.google.account))
  }
  return new ToolRegistry(tools)
}
