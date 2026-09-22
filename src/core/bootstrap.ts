import { DEFAULT_SYSTEM_PROMPT } from './agent/system.js'
import { memoryDir } from './config/paths.js'
import { readAuth, resolveSearchKey, type LoadedConfig } from './config/load.js'
import { createMemory } from './memory/index.js'
import { createProvider } from './providers/create.js'
import { AgentRuntime } from './runtime.js'
import { createSearchProvider } from './search/index.js'
import { createJevReviewer } from './tools/jev.js'
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

  return new AgentRuntime({
    provider: createProvider(loaded.provider, loaded.model),
    model: loaded.model,
    system: loaded.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    registry: createToolRegistry({ search }),
    memory: createMemory(loaded.config.memory, memoryDir()),
    cwd,
    maxSteps: loaded.config.maxSteps,
    permissionPolicy: new DefaultPermissionPolicy({
      mode: permissions.mode,
      allow: permissions.allow,
      deny: permissions.deny,
      threshold: permissions.jevThreshold,
      reviewer: createReviewer(loaded),
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
