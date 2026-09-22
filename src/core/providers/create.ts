import { AnthropicProvider } from './anthropic.js'
import { OpenAIProvider } from './openai.js'
import type { Provider } from './types.js'

export type Wire = 'openai' | 'anthropic' | 'auto'

export interface ProviderInit {
  id: string
  baseURL: string
  apiKey?: string | false
  wire?: Wire
  headers?: Record<string, string>
}

export function resolveWire(wire: Wire | undefined, model: string): 'openai' | 'anthropic' {
  if (wire === 'openai' || wire === 'anthropic') return wire
  return /^claude/i.test(model) ? 'anthropic' : 'openai'
}

export function createProvider(init: ProviderInit, model: string): Provider {
  const apiKey = init.apiKey === false ? undefined : init.apiKey
  const wire = resolveWire(init.wire, model)

  if (wire === 'anthropic') {
    return new AnthropicProvider({
      id: init.id,
      baseURL: init.baseURL,
      apiKey,
      headers: init.headers,
    })
  }

  return new OpenAIProvider({
    id: init.id,
    baseURL: init.baseURL,
    apiKey,
    headers: init.headers,
  })
}
