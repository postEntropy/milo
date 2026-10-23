export function splitNames(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
