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
  save(record: SessionRecord): Promise<void>
  list(): Promise<SessionSummary[]>
  remove(id: string): Promise<void>
  getBinding(scopeKey: string): Promise<string | undefined>
  setBinding(scopeKey: string, id: string): Promise<void>
}

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
