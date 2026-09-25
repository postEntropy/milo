import path from 'node:path'
import { DEFAULT_SYSTEM_PROMPT } from './agent/system.js'
import { BrowserSession } from './browser/index.js'
import { browserProfileDir, memoryDir, recapsDir, sessionsDir, skillsDir } from './config/paths.js'
import { readAuth, resolveSearchKey, type LoadedConfig } from './config/load.js'
import { fileHistory } from './history.js'
import { createMemory } from './memory/index.js'
import { createProvider } from './providers/create.js'
import { lookupContextWindow } from './providers/context.js'
import { AgentRuntime } from './runtime.js'
import { FileRecapStore, FileSessionStore } from './sessions/index.js'
import { createSearchProvider } from './search/index.js'
import { discoverSkills, ensureSkillsDir } from './skills/index.js'
import { createJevReviewer } from './tools/jev.js'
import { resolveToolPath } from './tools/walk.js'
import {
  DefaultPermissionPolicy,
  createToolRegistry,
  type DangerReviewer,
} from './tools/index.js'

export function createRuntime(loaded: LoadedConfig, cwd: string): AgentRuntime {
  const search = createSearchProvider(
    loaded.config.search,
    resolveSearchKey(loaded.config.search, readAuth()),
  )
  const permissions = loaded.config.permissions
  // Somewhere to put a skill, made from the first run: the directory is Milo's
  // to create, and nothing else ever would. A project skill overrides a global
  // one of the same name, and the index of all of them rides along with every
  // request — the bodies stay on disk.
  ensureSkillsDir()
  const skills = discoverSkills([
    { dir: skillsDir(), source: 'global' },
    { dir: path.join(cwd, '.milo', 'skills'), source: 'project' },
  ])

  // Only built when the feature is on: the browser is a process with a lifetime
  // and three tools in the catalog, and neither should exist for an install that
  // never asked for one. Nothing is started here — the first browser call does.
  const browser = loaded.config.browser.enabled
    ? new BrowserSession({
        chromePath: loaded.config.browser.chromePath,
        // Its own unless one was named — and a named one is expanded like every
        // other path Milo takes, so `~/profiles/chrome-copy` means what it says.
        profileDir: loaded.config.browser.profileDir
          ? resolveToolPath(cwd, loaded.config.browser.profileDir)
          : browserProfileDir(),
        headless: loaded.config.browser.headless,
        cdpUrl: loaded.config.browser.cdpUrl,
      })
    : null

  return new AgentRuntime({
    provider: createProvider(loaded.provider, loaded.model),
    model: loaded.model,
    system: loaded.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    registry: createToolRegistry({ search, skills, browser }),
    browser,
    keepSnapshots: loaded.config.browser.keepSnapshots,
    memory: createMemory(loaded.config.memory, memoryDir()),
    store: new FileSessionStore({ dir: sessionsDir() }),
    recaps: new FileRecapStore({ dir: recapsDir() }),
    history: fileHistory,
    skills,
    sessions: loaded.config.sessions,
    // Where the compaction ceiling comes from: a model's window is not in the
    // config and not in the request, so it is looked up once and cached.
    lookupContextWindow,
    reasoningEffort: loaded.config.reasoningEffort,
    cwd,
    maxSteps: loaded.config.maxSteps,
    maxTokens: loaded.config.maxTokens,
    permissionPolicy: new DefaultPermissionPolicy({
      mode: permissions.mode,
      allow: permissions.allow,
      deny: permissions.deny,
      threshold: permissions.jevThreshold,
      reviewer: createReviewer(loaded),
      cwd,
    }),
  })
}

/** The reviewer is only available where the decision model is: Command Code. */
function createReviewer(loaded: LoadedConfig): DangerReviewer | null {
  if (!loaded.provider.baseURL.includes('commandcode.ai')) return null
  const apiKey = typeof loaded.provider.apiKey === 'string' ? loaded.provider.apiKey : undefined
  if (!apiKey) return null

  return createJevReviewer({
    baseURL: loaded.provider.baseURL,
    apiKey,
    headers: loaded.provider.headers,
    timeoutMs: loaded.config.permissions.jevTimeoutMs,
  })
}
