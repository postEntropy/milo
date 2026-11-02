import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { findPreset } from '../config/presets.js'
import { normalizeModels, type ModelInfo } from '../providers/models.js'
import { errorMessage } from '../../util/errors.js'
import { logDebug } from '../../util/log.js'
import { codexHome } from './token.js'

/**
 * The models a ChatGPT subscription serves, from the catalog the Codex CLI keeps
 * on this machine when it is installed. Falls back to the preset's short list:
 * the backend has no `/models` endpoint Milo can ask, and an empty picker would
 * hide the only thing the grant is for.
 */
export function chatGptModels(): ModelInfo[] {
  const file = path.join(codexHome(), 'models_cache.json')
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const raw =
        parsed && typeof parsed === 'object' && Array.isArray((parsed as { models?: unknown }).models)
          ? ((parsed as { models: unknown[] }).models)
          : []
      const visible = raw.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).visibility !== 'hide' &&
          (item as Record<string, unknown>).supported_in_api !== false,
      )
      const models = normalizeModels(visible)
      if (models.length > 0) {
        const reasoning = new Map(
          visible
            .filter((item) => Array.isArray(item.supported_reasoning_levels))
            .map((item) => [String(item.slug ?? item.id ?? ''), true] as const),
        )
        return models.map((model) => (reasoning.has(model.id) ? { ...model, reasoning: true } : model))
      }
    } catch (error) {
      logDebug(`could not read ${file}: ${errorMessage(error)}`)
    }
  }
  return (findPreset('chatgpt')?.models ?? []).map((id) => ({ id }))
}
