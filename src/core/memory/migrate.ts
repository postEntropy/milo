import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { MemoryInput, MemoryItem, MemoryLayer } from './types.js'

/** One conversation's worth of what `FileMemory` left behind. */
export interface LegacyScope {
  scope: string
  items: (MemoryInput & { createdAt: number })[]
}

/**
 * Reads what `FileMemory` wrote: one `<scope>.json` per conversation, an array
 * of items. Deliberately read-only — the JSON files stay where they are, so
 * going back to `backend: "file"` still works and a migration that goes wrong
 * has cost nothing.
 *
 * A file a kill left half-written is skipped rather than fatal: this is memory,
 * and losing one conversation's notes beats refusing to open the store at all.
 */
export function readLegacyMemory(dir: string): LegacyScope[] {
  if (!existsSync(dir)) return []

  const scopes: LegacyScope[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue

    const items = parsed
      .filter(isItem)
      .map((item) => ({
        text: item.text.trim(),
        tags: item.tags,
        kind: layerOf(item.tags),
        // The original time is kept: a recency tie-break over notes imported at
        // one instant would otherwise rank them by nothing at all.
        createdAt: item.createdAt,
      }))
      .filter((item) => item.text.length > 0)

    if (items.length === 0) continue
    scopes.push({ scope: scopeFromFile(name), items })
  }

  return scopes
}

/**
 * `FileMemory` named each file after the scope with everything outside
 * `[a-zA-Z0-9._-]` flattened to `_`, so `cli:main` was stored as `cli_main.json`.
 * A scope key is `gateway:conversationId` — the gateway is one of a known set of
 * words and a conversation id is an id, so putting the first separator back
 * recovers the key exactly. `userId` is never set today, and if it ever is this
 * is the one place that has to learn about it.
 */
function scopeFromFile(name: string): string {
  const bare = name.slice(0, -'.json'.length)
  const cut = bare.indexOf('_')
  return cut === -1 ? bare : `${bare.slice(0, cut)}:${bare.slice(cut + 1)}`
}

/**
 * The old store only had tags to go on, and its two writers are distinct: the
 * `remember` tool writes `assistant`, the end of a turn writes `user`.
 */
function layerOf(tags: string[] | undefined): MemoryLayer {
  return tags?.includes('user') ? 'said' : 'fact'
}

function isItem(value: unknown): value is MemoryItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<MemoryItem>
  return typeof item.text === 'string' && typeof item.createdAt === 'number'
}
