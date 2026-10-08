import { DEFAULT_SYSTEM_PROMPT } from './agent/system.js'
import { BrowserSession } from './browser/index.js'
import { browserProfileDir, embedEngineDir, historyDir, memoryDir, recapsDir, sessionsDir, skillsDir } from './config/paths.js'
import { readAuth, readConfig, resolveClassifierKey, resolveProvider, resolveSearchKey, type LoadedConfig, type ResolvedProvider } from './config/load.js'
import { findPreset } from './config/presets.js'
import { fileHistory } from './history.js'
import { googleState } from './google/state.js'
import { createMcpServers } from './mcp/servers.js'
import { createMemory, embeddingKey, installMemory, TurnIndex } from './memory/index.js'
import { engineOnDemand } from './memory/provision.js'
import {
  addRoutine,
  readRoutines,
  removeRoutineWithRuns,
  updateRoutine,
} from './routines.js'
import { createProvider } from './providers/create.js'
import type { Provider } from './providers/types.js'
import { fileTraces, TracedProvider, type TraceWriter } from './traces.js'
import { lookupContextWindow } from './providers/context.js'
import { AgentRuntime } from './runtime.js'
import { FileRecapStore, FileSessionStore, pruneSessions } from './sessions/index.js'
import { createSearchProvider } from './search/index.js'
import { ensureSkillsDir, SkillLibrary } from './skills/index.js'
import { createClassifier, dangerousReviewer, type Classifier } from './classifier/index.js'
import { OLLAYA_DEFAULT_MODEL, OLLAYA_URL, OPENAI_DECISIONS_MODEL, OPENAI_DECISIONS_URL, OPENROUTER_DECISIONS_MODEL, OPENROUTER_URL, type Auth } from './config/schema.js'
import { resolveToolPath } from './tools/walk.js'
import {
  DefaultPermissionPolicy,
  createToolRegistry,
  type RoutineStore,
} from './tools/index.js'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'

export function createRuntime(loaded: LoadedConfig, cwd: string): AgentRuntime {
  const auth = readAuth()
  // The execution log: on unless the config turned it off. One writer for the
  // whole process, so every request, tool call and turn lands in the same file.
  const traces = loaded.config.traces.enabled ? fileTraces : null
  // Every model call goes through the provider, so timing it here is the one
  // place that covers the chat turn, a subtask and the mechanical calls alike.
  const traced = (provider: Provider): Provider =>
    traces ? new TracedProvider(provider, traces) : provider
  // Wanted is not the same as connected: a config that asks for Google gets the
  // tools, and an account that has not been granted yet is a state the tools and
  // the setup screen both speak about.
  const google = loaded.config.google.enabled ? { account: auth.google ?? null } : null
  const search = createSearchProvider(
    loaded.config.search,
    resolveSearchKey(loaded.config.search, auth),
  )
  const permissions = loaded.config.permissions
  // Somewhere to put a skill, made from the first run: the directory is Milo's
  // to create, and nothing else ever would. The index of what it holds rides
  // along with every request — the bodies stay on disk.
  ensureSkillsDir()
  // Read through the library, not once: the index it feeds is rebuilt when the
  // directory moves, so a skill installed from a settings screen is served from
  // the next turn on. The bodies stay on disk.
  const skills = new SkillLibrary(skillsDir())

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

  // The external tool servers. The file and the cache of what they last said are
  // read here, and registering their tools is part of building the registry
  // below — so the catalog is complete before the first turn without a
  // subprocess existing yet. `warm()` is what connects them, and nothing waits.
  const mcp = createMcpServers(cwd)

  const store = new FileSessionStore({ dir: sessionsDir() })
  const recaps = new FileRecapStore({ dir: recapsDir() })
  // A run leaves a session behind once it is spoken in, so the directory is
  // pruned on the way in — and the empties a run opened but never used are
  // swept with it. Not waited for: the first turn does not need it, and a prune
  // is not a reason to keep someone waiting at the prompt.
  void pruneSessions(store, recaps, loaded.config.sessions.maxSessions).catch((error) => {
    logWarn(`could not prune old sessions: ${errorMessage(error)}`)
  })

  // The provider in use, movable at runtime. A surface that switches provider
  // resolves the id from what is on disk at that moment, so one configured since
  // startup is found without rebuilding the runtime — and every later model
  // resolves against whichever is active, not the one the process started on.
  let activeProvider = loaded.provider
  const resolveActive = (id: string): ResolvedProvider | undefined =>
    resolveProvider(readConfig() ?? loaded.config, readAuth(), id)

  // Built once, before the registry: the permission layer asks it P(dangerous), the
  // inbox asks it to sort mail into labels, and the label tool asks it to answer
  // which messages carry one. One instance, so those cannot land on different backends.
  const classifier = buildClassifier(loaded, auth, traces)

  const registry = createToolRegistry({
    search,
    skills,
    browser,
    google: google ? { account: google.account, classifier } : null,
    mcp,
  })

  // The install's routine list, as the `routine` tool sees it. A removal takes the
  // runs the routine left behind with it — they are reachable only through it —
  // which needs the runtime that owns the session store. `runtime` is assigned on
  // the next statement and the closure reads it when a removal happens, long after.
  let runtime: AgentRuntime
  const routines: RoutineStore = {
    list: readRoutines,
    create: addRoutine,
    update: updateRoutine,
    remove: (id) => removeRoutineWithRuns(runtime, id),
  }

  runtime = new AgentRuntime({
    provider: traced(createProvider(loaded.provider, loaded.model)),
    // One entry, and the model it is on: `auto` picks its wire from the model
    // id, so a model switched later resolves a provider of its own instead of
    // keeping the wire of the one it replaced.
    providerFor: (model) => traced(createProvider(activeProvider, model)),
    providerSwitch: {
      use: (id) => {
        const next = resolveActive(id)
        if (!next) return false
        activeProvider = next
        return true
      },
      name: (id) => resolveActive(id)?.name ?? findPreset(id)?.name ?? id,
    },
    model: loaded.model,
    mediaModels: loaded.config.media,
    system: loaded.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    registry,
    mcp,
    // The grant as this run sees it, from the same function the CLI, the setup
    // screen and the web panel read — so the prompt cannot describe the
    // connection a fourth way. A grant made later needs a restart anyway.
    google: googleState(loaded.config, auth),
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
    traces: traces ?? undefined,
    // The routine list the model reads and changes, backed by the install's file;
    // `milo serve` is what runs it.
    routine: routines,
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
      reviewer: classifier ? dangerousReviewer(classifier) : null,
      cwd,
    }),
    classifier,
  })

  // Connecting the servers is not startup work: the first turn already has their
  // tools from the cache, and an `npx` server takes seconds to answer. The warm
  // is started here and never awaited, which is the whole reason a configured MCP
  // server costs nothing at boot.
  void mcp.warm()

  return runtime
}

/**
 * The decision model the install points at, from whichever backend the config names.
 * The hosted jev still rides on the chat provider, so it exists only where that model
 * is; the OpenAI Decisions API, a local Ollaya or a custom endpoint stands on its own,
 * independent of the provider the conversation runs on. Null when none is configured:
 * the permission layer then asks instead of guessing, and the inbox goes unlabelled.
 */
function buildClassifier(loaded: LoadedConfig, auth: Auth, traces: TraceWriter | null): Classifier | null {
  const config = loaded.config.classifier
  // The classifier's own timeout wins; a file that only set the old permission
  // key keeps working, hence the fallback.
  const timeoutMs = config.timeoutMs ?? loaded.config.permissions.jevTimeoutMs

  if (config.backend === 'commandcode') {
    if (!loaded.provider.baseURL.includes('commandcode.ai')) return null
    const apiKey = typeof loaded.provider.apiKey === 'string' ? loaded.provider.apiKey : undefined
    if (!apiKey) return null

    return createClassifier({
      baseURL: loaded.provider.baseURL,
      apiKey,
      headers: loaded.provider.headers,
      model: config.model,
      timeoutMs,
      backend: config.backend,
      traces: traces ?? undefined,
    })
  }

  // openai: the Decisions API, a hosted classifier of its own, on the OpenAI
  // wire. It needs a key even though it does not ride on the chat provider.
  if (config.backend === 'openai') {
    const apiKey = resolveClassifierKey(config, auth)
    if (!apiKey) return null

    return createClassifier({
      baseURL: config.url ?? OPENAI_DECISIONS_URL,
      apiKey,
      model: config.model ?? OPENAI_DECISIONS_MODEL,
      wire: 'openai',
      timeoutMs,
      backend: config.backend,
      traces: traces ?? undefined,
    })
  }

  // openrouter | ollaya | custom: a TypeSafe-compatible endpoint of its own, so
  // the reviewer no longer has to live where the chat does. OpenRouter serves its
  // decision models over the same wire, so it is a preset over this branch.
  const baseURL =
    config.url ??
    (config.backend === 'openrouter'
      ? OPENROUTER_URL
      : config.backend === 'ollaya'
        ? OLLAYA_URL
        : undefined)
  if (!baseURL) return null

  const defaultModel =
    config.backend === 'openrouter'
      ? OPENROUTER_DECISIONS_MODEL
      : config.backend === 'ollaya'
        ? OLLAYA_DEFAULT_MODEL
        : undefined

  return createClassifier({
    baseURL,
    // Ollaya accepts any value; it is a local daemon, not a keyed service.
    apiKey:
      resolveClassifierKey(config, auth) || (config.backend === 'ollaya' ? 'local' : undefined),
    model: config.model ?? defaultModel,
    timeoutMs,
    backend: config.backend,
    traces: traces ?? undefined,
  })
}
