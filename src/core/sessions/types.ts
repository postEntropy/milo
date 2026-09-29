import type { Message } from '../providers/types.js'

/**
 * A session is the conversation itself — a named entity that outlives the
 * transport address it happens to be bound to. The gateway address
 * (`MemoryScope`) is only a pointer to one of these.
 */
export interface SessionRecord {
  id: string
  title?: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  /**
   * Revision of the record, bumped by the store on every accepted save. A write
   * names the revision it is based on, so a save built from a copy another
   * process has since moved on from is refused instead of erasing its turns.
   */
  version: number
  /** Summary of the turns compaction has already dropped. */
  summary?: string
  /** How many estimated tokens have been summarized away so far. */
  droppedTokens?: number
}

export interface SessionSummary {
  id: string
  title?: string
  createdAt: number
  updatedAt: number
  messageCount: number
  preview: string
  recap?: string
}

/** The numbers behind `/stats`. */
export interface SessionStats {
  id: string
  title?: string
  createdAt: number
  updatedAt: number
  /** What the person said and what the model answered — a tool result behind a
   *  call is not a message of its own. */
  messages: number
  turns: number
  tokens: number
  /** Estimated size of the system prompt, which `tokens` does not include. */
  systemTokens?: number
  /**
   * The context budget `tokens` and `systemTokens` are measured against — the
   * point where the oldest turns get summarized. Without it a token count says
   * nothing about whether the session is anywhere near that.
   */
  maxInputTokens?: number
  compacted: boolean
  droppedTokens?: number
}

/**
 * What asking for a compaction did — or why there was nothing to do. The two
 * are not the same answer and must not read as one: a session of two turns has
 * nothing to fold, and replying "compacted" there is a claim the next request's
 * size immediately contradicts.
 */
export interface CompactResult {
  /** Turns folded into the summary. */
  folded: number
  /** What those turns held, in estimated tokens. */
  tokens: number
  /** How long the summary call took. */
  ms: number
  /** False when the model gave no summary and the turns were dropped plain. */
  summarized: boolean
  /** Set when nothing was folded, saying why. */
  reason?: string
}

/**
 * Persistence for sessions. `create` generates the id, so the store is the only
 * thing that has to guarantee it is unique. The binding maps a transport
 * address (`scopeKey`) to the session currently bound to it.
 */
export interface SessionStore {
  create(): Promise<SessionRecord>
  load(id: string): Promise<SessionRecord | null>
  /**
   * Writes the record only if the stored one is still at `expectedVersion`,
   * bumping it on success. A stale write rejects with `SessionConflictError`
   * rather than overwriting a newer revision — the safety net under the lease.
   */
  save(record: SessionRecord, expectedVersion: number): Promise<void>
  /** Takes the session if it is free; null when another holder has it. */
  tryAcquire(id: string): Promise<SessionLease | null>
  /**
   * Takes the session, waiting for whoever holds it. The wait is abandoned if
   * `signal` aborts, so a stopped turn does not hang behind another one.
   */
  acquire(id: string, options?: { signal?: AbortSignal }): Promise<SessionLease>
  list(): Promise<SessionSummary[]>
  remove(id: string): Promise<void>
  /**
   * Deletes every session beyond the `keep` most recently updated, returning the
   * ids removed. A session a scope is bound to is never pruned, nor one named in
   * `protect`: a binding to a session that is gone would silently start a new
   * conversation on the next message. The store's own `remove` is what deletes,
   * so a prune waits for a turn the way a removal does.
   */
  prune(options: { keep: number; protect?: Iterable<string> }): Promise<string[]>
  getBinding(scopeKey: string): Promise<string | undefined>
  setBinding(scopeKey: string, id: string): Promise<void>
}

/**
 * Raised when a save was built from a revision the store has moved past — the
 * same session open in two processes (`milo` and `milo serve`, say, or two
 * `/resume`s of one session). Refusing the write is what stops the older copy
 * from silently erasing the turns the newer one added.
 */
export class SessionConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `session ${sessionId} was changed by another process (expected version ${expected}, found ${actual}); this change was not saved`,
    )
    this.name = 'SessionConflictError'
  }
}

/**
 * Exclusivity over one session, held for as long as a turn runs.
 *
 * Two processes reach the same session whenever they reach the same transport
 * address — two `milo` terminals both bind `cli:main` — and a daemon may hold a
 * session a terminal resumes. Serializing the turn is what keeps one of them
 * from folding its transcript into the middle of the other's.
 */
export interface SessionLease {
  /**
   * The record as it stands now, read under the lease. A holder builds on this,
   * not on whatever copy it happened to have in memory.
   */
  readonly latest: SessionRecord | null
  release(): Promise<void>
}

/**
 * Revision a record starts at when it is created — and what a record written by
 * an older version, which carried no revision at all, is read as. The first
 * accepted save moves it to `1`.
 */
export const INITIAL_SESSION_VERSION = 0

/** `calm-otter-7`: lowercase words, safe to type and to use as a file name. */
export const SESSION_ID_PATTERN = /^[a-z]+-[a-z]+-\d{1,3}$/

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id)
}

export function countTurns(messages: Message[]): number {
  let turns = 0
  for (const message of messages) if (message.role === 'user') turns += 1
  return turns
}

/**
 * The messages a surface draws as the conversation: what the person said and
 * what the model answered. A tool result is not a message of its own — it
 * belongs to the turn that called it, and one message can carry several calls —
 * so counting it inflates the size shown for every conversation.
 */
export function countMessages(messages: Message[]): number {
  let count = 0
  for (const message of messages) {
    if (message.role === 'user' || message.role === 'assistant') count += 1
  }
  return count
}

/** First line of the first thing the user said, for listing sessions. */
export function previewOf(messages: Message[], limit = 80): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  }
  return ''
}

export function toSummary(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: countMessages(record.messages),
    preview: previewOf(record.messages),
  }
}
