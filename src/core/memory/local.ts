import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ensurePrivateDir, PRIVATE_FILE_MODE } from '../../util/fs.js'
import {
  scopeKey,
  type Memory,
  type MemoryInput,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
} from './types.js'
import { tokenize } from './tokenize.js'

const MAX_ITEMS = 500

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

/**
 * What the setup screen shows when this backend is the live one: read off the
 * directory, without building an instance. The layers are recovered from the tag
 * the same way the migration does, since this format never had a `kind`.
 */
export function fileMemoryStatus(dir: string): MemoryStatus {
  const status: MemoryStatus = {
    backend: 'file',
    location: dir,
    scopes: 0,
    facts: 0,
    said: 0,
    bytes: 0,
  }
  if (!existsSync(dir)) return status

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = path.join(dir, name)
    status.scopes += 1
    try {
      status.bytes += statSync(file).size
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed)) continue
      for (const item of parsed as MemoryItem[]) {
        if (item.tags?.includes('user')) status.said += 1
        else status.facts += 1
      }
    } catch {
      // A file a kill left half-written is still a scope and still bytes.
    }
  }
  return status
}
