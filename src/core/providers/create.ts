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

/**
 * What a wire reports to whoever built it. A provider is made for one model and
 * knows nothing about where the install keeps what it learns.
 */
export interface ProviderHooks {
  /**
   * The most this route said it accepts as output, learned from a refusal. Awaited
   * before the request is asked again, so the limit is on disk even if this is a
   * one-shot run whose process ends with the turn.
   */
  onOutputCap?: (tokens: number) => void | Promise<void>
}

export function resolveWire(wire: Wire | undefined, model: string): 'openai' | 'anthropic' {
  if (wire === 'openai' || wire === 'anthropic') return wire
  return /^claude/i.test(model) ? 'anthropic' : 'openai'
}

export function createProvider(init: ProviderInit, model: string, hooks?: ProviderHooks): Provider {
  const apiKey = init.apiKey === false ? undefined : init.apiKey
  const wire = resolveWire(init.wire, model)

  if (wire === 'anthropic') {
    return new AnthropicProvider({
      id: init.id,
      baseURL: init.baseURL,
      apiKey,
      headers: init.headers,
      onOutputCap: hooks?.onOutputCap,
    })
  }

  return new OpenAIProvider({
    id: init.id,
    baseURL: init.baseURL,
    apiKey,
    headers: init.headers,
    onOutputCap: hooks?.onOutputCap,
  })
}
