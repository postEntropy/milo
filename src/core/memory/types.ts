export interface MemoryScope {
  gateway: string
  conversationId: string
  userId?: string
}

/**
 * Which half of memory an entry belongs to.
 *
 * `fact` is something worth keeping past the conversation — what the `remember`
 * tool saves. `said` is a raw turn the person typed, kept because it is what a
 * question is answered *from*. Recall reads facts before turns, and eviction
 * never drops a fact to make room for chatter: an undifferentiated list let a
 * durable note be pushed out by small talk, which is the defect this splits.
 */
export type MemoryLayer = 'fact' | 'said'

export interface MemoryInput {
  text: string
  tags?: string[]
  /** Absent means `fact`. */
  kind?: MemoryLayer
}

export interface MemoryItem {
  id: string
  text: string
  createdAt: number
  tags?: string[]
  /**
   * 1 is the best match for the query, and it decreases from there. Comparable
   * within one reply, not across queries.
   */
  score?: number
}

/** What is actually in the store, for the setup screen. */
export interface MemoryStatus {
  backend: string
  /** The database file, or the directory of JSON files. */
  location: string
  scopes: number
  facts: number
  said: number
  bytes: number
}

export interface Memory {
  remember(scope: MemoryScope, items: MemoryInput[]): Promise<void>
  recall(scope: MemoryScope, query: string, opts?: { limit?: number }): Promise<MemoryItem[]>
}

export function scopeKey(scope: MemoryScope): string {
  return [scope.gateway, scope.conversationId, scope.userId].filter(Boolean).join(':')
}
