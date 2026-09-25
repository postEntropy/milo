import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ensurePrivateDir, PRIVATE_FILE_MODE } from '../../util/fs.js'
import { scopeKey, type Memory, type MemoryInput, type MemoryItem, type MemoryScope } from './types.js'

const MAX_ITEMS = 500
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'was',
  'were', 'be', 'been', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from', 'i', 'you',
  'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'e', 'ou', 'que', 'em', 'no', 'na',
  'para', 'por', 'com', 'se', 'meu', 'minha', 'eu', 'voce', 'você', 'é',
])

export interface FileMemoryOptions {
  dir: string
  debug?: boolean
}

/**
 * Minimal local memory: a JSON file per conversation scope, retrieved by
 * keyword overlap plus a recency bonus. Deliberately dependency-free so the
 * memory layer exists and is testable before a third-party backend is chosen.
 */
export class FileMemory implements Memory {
  private readonly dir: string
  private readonly debug: boolean

  constructor(options: FileMemoryOptions) {
    this.dir = options.dir
    this.debug = options.debug ?? process.env.MILO_DEBUG === '1'
  }

  async remember(scope: MemoryScope, items: MemoryInput[]): Promise<void> {
    if (items.length === 0) return
    const file = this.fileFor(scope)
    const stored = this.load(file)
    const createdAt = Date.now()

    items.forEach((item, index) => {
      const text = item.text.trim()
      if (!text) return
      stored.push({
        id: `${createdAt.toString(36)}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        createdAt,
        tags: item.tags,
      })
    })

    const trimmed = stored.slice(-MAX_ITEMS)
    this.persist(file, trimmed)
    if (this.debug) {
      console.error(`[memory] remember ${scopeKey(scope)}: +${items.length} (total ${trimmed.length})`)
    }
  }

  async recall(scope: MemoryScope, query: string, opts?: { limit?: number }): Promise<MemoryItem[]> {
    const limit = opts?.limit ?? 5
    const file = this.fileFor(scope)
    const stored = this.load(file)
    const queryTokens = tokenize(query)
    if (stored.length === 0 || queryTokens.size === 0) return []

    const now = Date.now()
    const scored = stored
      .map((item) => {
        const tokens = tokenize(item.text)
        let overlap = 0
        for (const token of queryTokens) if (tokens.has(token)) overlap += 1
        const ageDays = Math.max(0, (now - item.createdAt) / 86_400_000)
        const recency = 1 / (1 + ageDays)
        return { ...item, score: overlap + recency * 0.5 }
      })
      // The bonus only ever reorders: at most 0.5, so a memory has to share a
      // word with the question to come back at all. Recall that answers every
      // question with whatever was said most recently is worse than one that
      // answers nothing.
      .filter((item) => (item.score ?? 0) > 0.5)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)

    if (this.debug) {
      console.error(
        `[memory] recall ${scopeKey(scope)} "${query.slice(0, 40)}": ${scored.length} hit(s)`,
      )
    }
    return scored
  }

  private fileFor(scope: MemoryScope): string {
    const safe = scopeKey(scope).replace(/[^a-zA-Z0-9._-]+/g, '_')
    return path.join(this.dir, `${safe}.json`)
  }

  private load(file: string): MemoryItem[] {
    if (!existsSync(file)) return []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as MemoryItem[]) : []
    } catch {
      return []
    }
  }

  private persist(file: string, items: MemoryItem[]): void {
    ensurePrivateDir(this.dir)
    writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`, { mode: PRIVATE_FILE_MODE })
    // A memory file written before this was tightened is the one that needs it.
    chmodSync(file, PRIVATE_FILE_MODE)
  }
}

export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    // Two characters, not three: `rm`, `go`, `io` and `db` are exactly the kind
    // of term a question about a project turns on, and dropping them meant a
    // memory could never be recalled by the word the user actually used.
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  return new Set(tokens)
}
