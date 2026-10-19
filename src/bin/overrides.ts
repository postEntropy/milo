import { readAuth, resolveApiKey, type LoadedConfig } from '../core/config/load.js'
import type { Args } from './args.js'

/**
 * The provider and model a run was told to use, applied to what the file says.
 * Both surfaces that can name one — the chat and `milo run` — go through here,
 * so a flag means the same thing on either.
 */
export function applyOverrides(loaded: LoadedConfig, args: Args): void {
  if (args.provider) {
    const entry = loaded.config.providers[args.provider]
    if (!entry) throw new Error(`Provider "${args.provider}" is not configured.`)
    loaded.provider = {
      id: args.provider,
      name: entry.name,
      baseURL: entry.baseURL,
      wire: entry.wire,
      headers: entry.headers,
      apiKey: resolveApiKey(args.provider, entry, readAuth()),
    }
  }
  if (args.model) loaded.model = args.model
}
