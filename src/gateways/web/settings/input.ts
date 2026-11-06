const SESSION_ID = /^[a-z]+-[a-z]+-\d{1,3}$/

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Text a call cannot do without: absent reads as the reason, not as an empty value. */
export function requireText(value: unknown, what: string): string {
  const text = optionalText(value)
  if (!text) throw new Error(`A ${what} is required.`)
  return text
}

/** A project id as the page sends it: the nickname shape, and nothing else. */
export function projectId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Invalid project id.')
  return value
}

export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Invalid session id.')
  return value
}
