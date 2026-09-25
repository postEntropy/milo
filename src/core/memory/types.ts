export interface MemoryScope {
  gateway: string
  conversationId: string
  userId?: string
}

export interface MemoryInput {
  text: string
  tags?: string[]
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
  /** The database file. */
  location: string
  scopes: number
  facts: number
  bytes: number
}

export interface Memory {
  remember(scope: MemoryScope, items: MemoryInput[]): Promise<void>
  recall(scope: MemoryScope, query: string, opts?: { limit?: number }): Promise<MemoryItem[]>
  /** Everything kept, newest first — what `/memory` shows. */
  list(scope: MemoryScope, opts?: { limit?: number }): Promise<MemoryItem[]>
  /**
   * Drops one note. A full id, or as much of the front of one as stays
   * unambiguous; false when nothing was removed.
   */
  forget(scope: MemoryScope, id: string): Promise<boolean>
}

/**
 * Where recall finds the person's own words.
 *
 * The store holds facts — what the model decided was worth keeping. What was
 * typed is in the history log, once, and this is the seam that lets a question be
 * answered from it without a second copy existing in the store. The log is the
 * long-term record: it outlives every session, `/clear` and compaction, and
 * nothing evicts it.
 */
export interface TurnSource {
  recall(scope: MemoryScope, query: string, opts?: { limit?: number }): Promise<MemoryItem[]>
}

export function scopeKey(scope: MemoryScope): string {
  return [scope.gateway, scope.conversationId, scope.userId].filter(Boolean).join(':')
}

/**
 * The scope an install's memory lives under.
 *
 * A Milo install belongs to one person, so notes are not filed per
 * conversation: what was said in the terminal is meant to be there in Telegram.
 * The conversation scope still decides which *transcript* a message belongs to —
 * that is the part that stays per chat.
 */
export const INSTALL_SCOPE: MemoryScope = { gateway: 'local', conversationId: 'install' }
