import { generateNickname } from './nickname.js'
import { toSummary, type SessionRecord, type SessionStore, type SessionSummary } from './types.js'

export interface MemorySessionStoreOptions {
  now?: () => number
}

/**
 * Sessions in RAM. The default when no store is configured, which keeps the
 * runtime usable in tests without touching the disk.
 */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>()
  private readonly bindings = new Map<string, string>()
  private readonly now: () => number

  constructor(options: MemorySessionStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async create(): Promise<SessionRecord> {
    const id = generateNickname((candidate) => this.records.has(candidate))
    const timestamp = this.now()
    return { id, createdAt: timestamp, updatedAt: timestamp, messages: [] }
  }

  async load(id: string): Promise<SessionRecord | null> {
    return this.records.get(id) ?? null
  }

  async save(record: SessionRecord): Promise<void> {
    this.records.set(record.id, record)
  }

  async list(): Promise<SessionSummary[]> {
    return [...this.records.values()]
      .map(toSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id)
  }

  async getBinding(scopeKey: string): Promise<string | undefined> {
    return this.bindings.get(scopeKey)
  }

  async setBinding(scopeKey: string, id: string): Promise<void> {
    this.bindings.set(scopeKey, id)
  }
}
