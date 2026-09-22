/** Collapses whitespace and cuts the text down to what is worth sending to a model. */
export function condense(text: string, limit = 1200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}
