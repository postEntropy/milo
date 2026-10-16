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
  /**
   * What is kept, newest first — what `/memory` shows. `offset` skips that many,
   * so a caller can read the store a page at a time rather than all at once.
   */
  list(scope: MemoryScope, opts?: { limit?: number; offset?: number }): Promise<MemoryItem[]>
  /**
   * Drops one note. A full id, or as much of the front of one as stays
   * unambiguous; false when nothing was removed.
   */
  forget(scope: MemoryScope, id: string): Promise<boolean>
  /**
   * Sweeps one scope: drops the notes the admission gate would refuse today, and
   * folds the notes that are the same fact in another wording. Nothing is dropped
   * for its age.
   */
  prune(scope: MemoryScope): Promise<{ dropped: number; folded: number }>
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

/**
 * Enough of a note's id to name it without pasting a whole uuid: the prefix a
 * surface shows beside a note, and the one the model is given so it can ask for
 * that exact note to be dropped. One number, so the id a person reads in
 * `/memory` is the id the model is handed.
 */
export const MEMORY_ID_CHARS = 8

/** The front of a note's id, as a surface and the prompt both read it. */
export function shortId(uid: string): string {
  return uid.slice(0, MEMORY_ID_CHARS)
}
