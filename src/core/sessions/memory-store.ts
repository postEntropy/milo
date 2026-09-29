import { KeyedMutex, waitForLease } from './lease.js'
import { generateNickname } from './nickname.js'
import {
  INITIAL_SESSION_VERSION,
  SessionConflictError,
  toSummary,
  type SessionLease,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
} from './types.js'

export interface MemorySessionStoreOptions {
  now?: () => number
}

/**
 * Sessions in RAM. The default when no store is configured, which keeps the
 * runtime usable in tests without touching the disk.
 *
 * Records are copied in and out, so a caller mutating what it loaded cannot
 * reach past the version check — the same isolation the file store gets for free
 * by parsing the file on every read.
 */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>()
  private readonly bindings = new Map<string, string>()
  private readonly leases = new KeyedMutex()
  private readonly now: () => number

  constructor(options: MemorySessionStoreOptions = {}) {
    this.now = options.now ?? Date.now
  }

  async create(): Promise<SessionRecord> {
    const id = generateNickname((candidate) => this.records.has(candidate))
    const timestamp = this.now()
    const record: SessionRecord = {
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
      version: INITIAL_SESSION_VERSION,
    }
    this.records.set(id, record)
    return structuredClone(record)
  }

  async load(id: string): Promise<SessionRecord | null> {
    const record = this.records.get(id)
    return record ? structuredClone(record) : null
  }

  async save(record: SessionRecord, expectedVersion: number): Promise<void> {
    const actual = this.records.get(record.id)?.version ?? INITIAL_SESSION_VERSION
    if (actual !== expectedVersion) {
      throw new SessionConflictError(record.id, expectedVersion, actual)
    }
    this.records.set(record.id, { ...structuredClone(record), version: expectedVersion + 1 })
  }

  async tryAcquire(id: string): Promise<SessionLease | null> {
    const unlock = this.leases.tryAcquire(id)
    return unlock ? this.lease(id, unlock) : null
  }

  async acquire(id: string, options?: { signal?: AbortSignal }): Promise<SessionLease> {
    return this.lease(id, await waitForLease(this.leases.acquire(id), options?.signal))
  }

  private async lease(id: string, unlock: () => void): Promise<SessionLease> {
    return {
      latest: await this.load(id),
      release: async () => {
        unlock()
      },
    }
  }

  async list(): Promise<SessionSummary[]> {
    return [...this.records.values()]
      .map(toSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async remove(id: string): Promise<void> {
    // Behind the same lease a turn takes, so a removal cannot land in the middle
    // of one — the file store does the same, with its lock instead of this one.
    const unlock = await this.leases.acquire(id)
    try {
      this.records.delete(id)
    } finally {
      unlock()
    }
  }

  async prune(options: { keep: number; protect?: Iterable<string> }): Promise<string[]> {
    if (options.keep <= 0) return []
    const newest = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    if (newest.length <= options.keep) return []

    const keep = new Set(options.protect ?? [])
    for (const id of this.bindings.values()) keep.add(id)

    const removed: string[] = []
    for (const record of newest.slice(options.keep)) {
      if (keep.has(record.id)) continue
      await this.remove(record.id)
      removed.push(record.id)
    }
    return removed
  }

  async pruneEmpty(): Promise<string[]> {
    const removed: string[] = []
    for (const [id, record] of [...this.records]) {
      if (record.messages.length > 0) continue
      await this.remove(id)
      removed.push(id)
    }
    return removed
  }

  async getBinding(scopeKey: string): Promise<string | undefined> {
    return this.bindings.get(scopeKey)
  }

  async setBinding(scopeKey: string, id: string): Promise<void> {
    this.bindings.set(scopeKey, id)
  }
}
