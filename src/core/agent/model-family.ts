/**
 * The family of a model, when it is one whose habits are known.
 *
 * Read from the model id first: a gateway (`commandcode`, `opencode`) serves
 * several families, so the provider says nothing about which one answered.
 * Author-prefixed ids (`anthropic/claude-sonnet-5`) are read from their last
 * segment. The provider is the fallback only when it is itself the family.
 *
 * Two families, not one per model: a briefing speaks to a vice the family
 * shares. A family joins this union when a vice is observed in practice, never
 * by imagination — an unknown model gets the base prompt and nothing else.
 */
export type ModelFamily = 'anthropic' | 'openai'

export function modelFamily(provider: string, model: string): ModelFamily | undefined {
  const slug = model.toLowerCase().split('/').pop() ?? ''
  if (slug.startsWith('claude')) return 'anthropic'
  if (
    slug.startsWith('gpt-') ||
    slug.startsWith('chatgpt') ||
    slug.startsWith('codex') ||
    /^o[0-9]/.test(slug)
  ) {
    return 'openai'
  }
  const source = provider.toLowerCase()
  if (source === 'anthropic') return 'anthropic'
  if (source === 'openai') return 'openai'
  return undefined
}
