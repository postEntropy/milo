import { z } from 'zod'
import { listProviders, readAuth, readConfig, resolveApiKey } from '../config/load.js'
import { findPreset } from '../config/presets.js'
import { WireSchema, type WireInput } from '../config/schema.js'
import { listModels } from '../providers/models.js'
import { isCustomProviderId, removeCustomProvider, saveCustomProvider } from '../settings.js'
import { errorMessage } from '../../util/errors.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
  }),
  z.object({
    action: z.literal('test'),
    baseURL: z.string().optional().describe('Endpoint base URL to probe (for example http://127.0.0.1:8080/v1).'),
    id: z.string().optional().describe('Id of an already configured provider to test.'),
    wire: WireSchema.optional().describe('API format: openai, anthropic, responses, or auto.'),
  }),
  z.object({
    action: z.literal('save'),
    id: z.string().optional().describe('Provider id when updating an existing custom provider, or an explicit slug when creating.'),
    name: z.string().describe('Display name for the provider (for example llama.cpp or Together AI).'),
    baseURL: z.string().describe('Endpoint base URL (for example http://127.0.0.1:8080/v1).'),
    wire: WireSchema.optional().describe('API format: openai (default), anthropic, responses, or auto.'),
    keyless: z.boolean().optional().describe('True when the endpoint requires no API key (typical for local llama.cpp/vLLM/Ollama servers).'),
    keyEnv: z.string().optional().describe('Optional environment variable name holding the API key.'),
  }),
  z.object({
    action: z.literal('remove'),
    id: z.string().describe('Id of the custom provider to remove.'),
  }),
  z.object({
    action: z.literal('use'),
    id: z.string().describe('Provider id to switch to.'),
    model: z.string().optional().describe('Model id served by that provider.'),
  }),
])

export type ProvidersArgs = z.infer<typeof schema>

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const MAX_PROBED_MODELS = 30
const PROBE_TIMEOUT_MS = 5_000

function validateProbeUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim().replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Enter a valid http:// or https:// endpoint URL.' }
  }
  if (parsed.protocol === 'https:') return { ok: true, url: trimmed }
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: true, url: trimmed }
  }
  return {
    ok: false,
    error: 'Endpoint test URLs must use HTTPS unless they point to localhost (127.0.0.1, localhost, or ::1).',
  }
}

function listConfigured(): ToolResult {
  const config = readConfig()
  if (!config) return { content: 'Milo is not configured yet.', isError: true }
  const auth = readAuth()
  const entries = Object.entries(config.providers)
  if (entries.length === 0) return { content: 'No providers are configured.' }

  const lines = entries.map(([id, entry]) => {
    const preset = findPreset(id)
    const label = entry.name ?? preset?.name ?? id
    const kind = isCustomProviderId(id) ? 'custom' : 'built-in'
    const wire = entry.wire ?? 'openai'
    const oauth = entry.oauth ?? preset?.oauth
    let keyStatus: string
    if (oauth === 'chatgpt') {
      keyStatus = auth.chatgpt ? 'ChatGPT sign-in active' : 'not signed in'
    } else if (entry.keyless) {
      keyStatus = 'no key required'
    } else if (auth.providers[id]?.trim()) {
      keyStatus = 'key set'
    } else if (entry.keyEnv && process.env[entry.keyEnv]?.trim()) {
      keyStatus = `env ${entry.keyEnv}`
    } else if (resolveApiKey(id, entry, auth)) {
      keyStatus = 'env key set'
    } else {
      keyStatus = 'no key set'
    }
    const active = id === config.provider ? ` · active (model: ${config.model})` : ''
    return `- ${id} — ${label} [${kind}, ${wire}] · ${entry.baseURL} · ${keyStatus}${active}`
  })

  return {
    content: [
      `Configured providers (${entries.length}), active: ${config.provider} / ${config.model}:`,
      ...lines,
    ].join('\n'),
  }
}

async function testEndpoint(args: Extract<ProvidersArgs, { action: 'test' }>, ctx: ToolContext): Promise<ToolResult> {
  let rawUrl = args.baseURL?.trim() ?? ''
  let wire: WireInput = args.wire ?? 'openai'
  let headers: Record<string, string> | undefined
  let apiKey: string | false | undefined

  if (args.id?.trim()) {
    const config = readConfig()
    const entry = config?.providers[args.id.trim()]
    if (!entry) {
      return { content: `Provider "${args.id.trim()}" is not configured.`, isError: true }
    }
    rawUrl = entry.baseURL
    wire = args.wire ?? entry.wire ?? 'openai'
    headers = entry.headers
    apiKey = resolveApiKey(args.id.trim(), entry, readAuth())
  }

  if (!rawUrl) {
    return { content: 'Provide baseURL or a configured provider id to test.', isError: true }
  }

  const checked = validateProbeUrl(rawUrl)
  if (!checked.ok) return { content: checked.error, isError: true }

  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
  try {
    const models = await listModels({ baseURL: checked.url, wire, headers, apiKey, signal })
    if (models.length === 0) {
      return {
        content: `Endpoint ${checked.url} (${wire}) responded to GET /models, but reported 0 models.`,
      }
    }
    const shown = models.slice(0, MAX_PROBED_MODELS).map((model) => {
      const ctxLabel = model.context ? ` (${Math.round(model.context / 1000)}k ctx)` : ''
      return `- ${model.id}${ctxLabel}`
    })
    const more = models.length > MAX_PROBED_MODELS ? `\n… and ${models.length - MAX_PROBED_MODELS} more.` : ''
    return {
      content: `Endpoint ${checked.url} (${wire}) is reachable and serves ${models.length} model(s):\n${shown.join('\n')}${more}`,
    }
  } catch (error) {
    return {
      content: `Could not reach ${checked.url}/models: ${errorMessage(error)}`,
      isError: true,
    }
  }
}

function saveProvider(args: Extract<ProvidersArgs, { action: 'save' }>, ctx: ToolContext): ToolResult {
  const res = saveCustomProvider({
    id: args.id,
    name: args.name,
    baseURL: args.baseURL,
    wire: args.wire,
    keyless: args.keyless,
    keyEnv: args.keyEnv,
    allowMissingKey: true,
  })
  if (!res.ok) return { content: res.error, isError: true }

  const { id, entry, created } = res.value
  ctx.providerAdmin?.refreshIfActive(id)

  const ready = resolveApiKey(id, entry, readAuth()) !== undefined
  const verb = created ? 'Added' : 'Updated'
  const status = entry.keyless
    ? 'Ready to use (no API key required).'
    : ready
      ? 'Ready to use.'
      : 'Saved, but no API key is set yet. Ask the user to add the key in Settings → API keys or `milo setup` (never paste API keys in chat).'

  return {
    content: `${verb} custom provider "${id}" (${entry.name ?? id}, ${entry.wire ?? 'openai'} at ${entry.baseURL}). ${status}`,
  }
}

function removeProvider(args: Extract<ProvidersArgs, { action: 'remove' }>): ToolResult {
  const res = removeCustomProvider(args.id)
  if (!res.ok) return { content: res.error, isError: true }
  return { content: `Removed custom provider "${res.value.id}".` }
}

function switchProvider(args: Extract<ProvidersArgs, { action: 'use' }>, ctx: ToolContext): ToolResult {
  if (!ctx.providerAdmin) {
    return { content: 'Provider switching is not available in this session.', isError: true }
  }
  const id = args.id.trim()
  const config = readConfig()
  const entry = config?.providers[id]
  if (!entry) return { content: `Provider "${id}" is not configured.`, isError: true }

  if (!listProviders().some((item) => item.id === id)) {
    const keyHint = entry.keyEnv
      ? `Add the key in Settings → API keys or set ${entry.keyEnv}.`
      : 'Add the key in Settings → API keys, or update it with keyless: true if it is a local server.'
    return { content: `Provider "${id}" cannot be used yet because no API key is set. ${keyHint}`, isError: true }
  }

  try {
    const switched = ctx.providerAdmin.use(id, args.model?.trim() || undefined)
    return {
      content: `Switched active provider to ${switched.name} (${switched.provider}) using model ${switched.model}.`,
    }
  } catch (error) {
    return { content: errorMessage(error), isError: true }
  }
}

export const providersTool: Tool<ProvidersArgs> = {
  name: 'providers',
  description:
    'Inspect, test, configure, remove, and switch model providers (for example a local llama.cpp server, vLLM, LM Studio, or any OpenAI/Anthropic-compatible endpoint). ' +
    'Use "list" to inspect configured providers, "test" to probe GET /models on a candidate URL or configured provider, "save" to add or update a custom provider, "use" to switch the active provider/model, and "remove" to delete an inactive custom provider. ' +
    'For local servers like llama.cpp that need no API key, pass keyless: true. Never ask the user to paste an API key into chat — pass keyEnv if using an environment variable, or tell them to add the key in Settings → API keys.',
  schema,
  readOnly: false,
  asksWhen: (args) => args.action !== 'list' && args.action !== 'test',
  async execute(args, ctx) {
    switch (args.action) {
      case 'list':
        return listConfigured()
      case 'test':
        return testEndpoint(args, ctx)
      case 'save':
        return saveProvider(args, ctx)
      case 'remove':
        return removeProvider(args)
      case 'use':
        return switchProvider(args, ctx)
    }
  },
}
