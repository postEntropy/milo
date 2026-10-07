import type { CLASSIFIER_BACKENDS, EFFORT_LEVELS, PERMISSION_MODES, SEARCH_PROVIDERS } from '@protocol'

/**
 * What each stored value is called on screen. One place, so every control that
 * offers these values — the settings dropdowns and the composer's effort pill —
 * reads them the same way, and as a capitalised word rather than the raw key.
 */
export const EFFORT_LABELS: Record<(typeof EFFORT_LEVELS)[number], string> = { low: 'Low', medium: 'Medium', high: 'High' }
export const SEARCH_LABELS: Record<(typeof SEARCH_PROVIDERS)[number], string> = { off: 'Off', tavily: 'Tavily', exa: 'Exa', parallel: 'Parallel' }
export const PERMISSION_LABELS: Record<(typeof PERMISSION_MODES)[number], string> = { ask: 'Ask', auto: 'Auto', yolo: 'YOLO' }
export const CLASSIFIER_LABELS: Record<(typeof CLASSIFIER_BACKENDS)[number], string> = { commandcode: 'Hosted', openai: 'OpenAI', openrouter: 'OpenRouter', ollaya: 'Ollaya', custom: 'Custom' }

/**
 * Where an installed skill came from, as a person reads it: a bundled one is
 * "Built-in", one dropped in by hand is "Local", and a source keeps its own name.
 */
export function skillOriginLabel(origin?: string): string {
  if (!origin) return 'Local'
  return origin === 'builtin' ? 'Built-in' : origin
}
