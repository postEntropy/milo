import path from 'node:path'
import { DEFAULT_SYSTEM_PROMPT } from './agent/system.js'
import { BrowserSession } from './browser/index.js'
import { browserProfileDir, embedEngineDir, historyDir, memoryDir, recapsDir, sessionsDir, skillsDir } from './config/paths.js'
import { readAuth, resolveSearchKey, type LoadedConfig } from './config/load.js'
import { fileHistory } from './history.js'
import { createMemory, embeddingKey, installMemory, TurnIndex } from './memory/index.js'
import { engineOnDemand } from './memory/provision.js'
import { addRoutine } from './routines.js'
import { createProvider } from './providers/create.js'
import { lookupContextWindow } from './providers/context.js'
import { AgentRuntime } from './runtime.js'
import { FileRecapStore, FileSessionStore, pruneSessions } from './sessions/index.js'
import { createSearchProvider } from './search/index.js'
import { discoverSkills, ensureSkillsDir } from './skills/index.js'
import { createClassifier, dangerousReviewer } from './classifier/index.js'
import { OLLAYA_DEFAULT_MODEL, OLLAYA_URL } from './config/schema.js'
import { resolveToolPath } from './tools/walk.js'
import {
  DefaultPermissionPolicy,
  createToolRegistry,
  type DangerReviewer,
} from './tools/index.js'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'

export function createRuntime(loaded: LoadedConfig, cwd: string): AgentRuntime {
  const auth = readAuth()
  const search = createSearchProvider(
    loaded.config.search,
    resolveSearchKey(loaded.config.search, auth),
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

  // The embedding engine is a process with a lifetime, so it is brought up here
  // and taken down with this process. Not waited for: the first turn does not
  // need embeddings to answer, and recall falls back to words until it answers.
  engineOnDemand({ embedding: loaded.config.memory.embedding, dir: embedEngineDir() })

  // What recall reads the person's own words from: an index over the history log
  // beside it. Derived and rebuildable, so it is created rather than checked.
  const turns = new TurnIndex({
    dir: historyDir(),
    windowDays: loaded.config.history.windowDays,
  })

  const store = new FileSessionStore({ dir: sessionsDir() })
  const recaps = new FileRecapStore({ dir: recapsDir() })
  // A run leaves a session behind once it is spoken in, so the directory is
  // pruned on the way in — and the empties a run opened but never used are
  // swept with it. Not waited for: the first turn does not need it, and a prune
  // is not a reason to keep someone waiting at the prompt.
  void pruneSessions(store, recaps, loaded.config.sessions.maxSessions).catch((error) => {
    logWarn(`could not prune old sessions: ${errorMessage(error)}`)
  })

  return new AgentRuntime({
    provider: createProvider(loaded.provider, loaded.model),
    // One entry, and the model it is on: `auto` picks its wire from the model
    // id, so a model switched later resolves a provider of its own instead of
    // keeping the wire of the one it replaced.
    providerFor: (model) => createProvider(loaded.provider, model),
    model: loaded.model,
    system: loaded.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    registry: createToolRegistry({ search, skills, browser }),
    browser,
    keepSnapshots: loaded.config.browser.keepSnapshots,
    memory: installMemory(
      createMemory(loaded.config.memory, memoryDir(), {
        // Only resolved when it is wanted: a key Milo never needs is a file it
        // does not have to read.
        apiKey:
          loaded.config.memory.embedding?.provider === 'openrouter'
            ? embeddingKey(loaded.config, auth)
            : undefined,
      }),
      turns,
    ),
    recallLimit: loaded.config.memory.recallLimit,
    derive: loaded.config.memory.derive,
    store,
    recaps,
    history: fileHistory,
    // A routine the model makes is filed here, not in the session: the list
    // belongs to the install, and `milo serve` is what runs it.
    routine: addRoutine,
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

/**
 * The danger reviewer, from whichever decision model the install points at. The
 * hosted one still rides on the chat provider, so it exists only where that model
 * is; a local Ollaya or a custom endpoint stands on its own, independent of the
 * provider the conversation runs on. Absent, `auto` degrades to asking.
 */
function createReviewer(loaded: LoadedConfig): DangerReviewer | null {
  const config = loaded.config.classifier
  // The classifier's own timeout wins; a file that only set the old permission
  // key keeps working, hence the fallback.
  const timeoutMs = config.timeoutMs ?? loaded.config.permissions.jevTimeoutMs

  if (config.backend === 'commandcode') {
    if (!loaded.provider.baseURL.includes('commandcode.ai')) return null
    const apiKey = typeof loaded.provider.apiKey === 'string' ? loaded.provider.apiKey : undefined
    if (!apiKey) return null

    return dangerousReviewer(
      createClassifier({
        baseURL: loaded.provider.baseURL,
        apiKey,
        headers: loaded.provider.headers,
        model: config.model,
        timeoutMs,
      }),
    )
  }

  // ollaya | custom: a TypeSafe-compatible endpoint of its own, so the reviewer
  // no longer has to live where the chat does.
  const baseURL = config.url ?? (config.backend === 'ollaya' ? OLLAYA_URL : undefined)
  if (!baseURL) return null
  const key = config.keyEnv ? process.env[config.keyEnv]?.trim() : undefined

  return dangerousReviewer(
    createClassifier({
      baseURL,
      // Ollaya accepts any value; it is a local daemon, not a keyed service.
      apiKey: key || (config.backend === 'ollaya' ? 'local' : undefined),
      model: config.model ?? (config.backend === 'ollaya' ? OLLAYA_DEFAULT_MODEL : undefined),
      timeoutMs,
    }),
  )
}
