import type { ReasoningEffort } from './types.js'

/**
 * How many tokens the Anthropic wire is handed to think, per effort level. That
 * wire takes a token budget rather than OpenAI's level, and requires it to be at
 * least 1024 and strictly below `max_tokens` — which the adapter enforces when
 * it sends one.
 */
export const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 2048,
  high: 4096,
}

/** The Anthropic thinking budget an effort level maps to. */
export function thinkingBudgetFor(effort: ReasoningEffort): number {
  return THINKING_BUDGETS[effort]
}
