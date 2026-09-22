export function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(typeof value === 'string' ? value : JSON.stringify(value))
}

export function errorMessage(value: unknown): string {
  return toError(value).message
}
