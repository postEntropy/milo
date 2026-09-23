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
    messageCount: record.messages.length,
    preview: previewOf(record.messages),
  }
}
