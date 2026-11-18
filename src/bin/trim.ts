export interface TrimFlags {
  days?: number
  before?: string
  yes: boolean
}

/** Shared parser for `--yes`, `--older-than <days>`, and `--before <YYYY-MM-DD>` flags. */
export function parseTrimFlags(argv: string[]): TrimFlags {
  const flags: TrimFlags = { yes: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--yes' || token === '-y') flags.yes = true
    else if (token === '--older-than') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value < 0) throw new Error('--older-than needs a number of days.')
      flags.days = value
    } else if (token === '--before') {
      const value = argv[++i]
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--before needs a date like 2025-01-31.')
      flags.before = value
    } else if (token.startsWith('-')) throw new Error(`Unknown option ${token}.`)
  }
  return flags
}
