import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { MemoryInput, MemoryItem } from './types.js'

/** One note out of the old store, with the time it was written. */
export type LegacyItem = MemoryInput & { createdAt: number }

/**
 * Reads the JSON-per-scope store Milo replaced: one `<scope>.json` per
 * conversation, an array of items.
 *
 * The file name said which conversation a note came from, and that is no longer
 * read back: an install's memory is one scope, so where a note was filed stops
 * mattering the moment it is imported. Deliberately read-only — the JSON files
 * stay where they are, so a migration that goes wrong has cost nothing and the
 * notes can still be read by hand.
 *
 * A file a kill left half-written is skipped rather than fatal: this is memory,
 * and losing one conversation's notes beats refusing to open the store at all.
 */
export function readLegacyMemory(dir: string): LegacyItem[] {
  if (!existsSync(dir)) return []

  const items: LegacyItem[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue

    for (const item of parsed.filter(isItem)) {
      const text = item.text.trim()
      if (text.length === 0) continue
      // What the end of a turn wrote to the old store was tagged `user`: those
      // were turns, not facts, and the history log is where turns live now. They
      // are left for it rather than imported, which is the whole point of the
      // split — this store holds what the model chose to keep.
      if (item.tags?.includes('user')) continue
      // The original time is kept: a recency tie-break over notes imported at
      // one instant would otherwise rank them by nothing at all.
      items.push({ text, tags: item.tags, createdAt: item.createdAt })
    }
  }

  return items
}

function isItem(value: unknown): value is MemoryItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<MemoryItem>
  return typeof item.text === 'string' && typeof item.createdAt === 'number'
}
