import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import lockfile, { type LockOptions } from 'proper-lockfile'
import { writeFileAtomic } from '../../util/fs.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import type { Message } from '../providers/types.js'
import { KeyedMutex, waitForLease } from './lease.js'
import { generateNickname } from './nickname.js'
import {
  INITIAL_SESSION_VERSION,
  isValidSessionId,
  SessionConflictError,
  toSummary,
  type SessionLease,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
} from './types.js'

const BINDINGS_DIR = 'bindings'
const LEGACY_BINDINGS_FILE = 'bindings.json'
const RECORD_SUFFIX = '.json'

/**
 * How long a lock is believed after the process holding it stops refreshing it.
 * A save holds its lock for milliseconds; the holder that dies is the one whose
 * lock this breaks. A turn holds its lease far longer, so it is refreshed while
 * it runs (proper-lockfile touches the lock every `stale / 2`).
 */
const LOCK_STALE_MS = 10_000
/** Save windows are short and rare: waiting is cheaper than failing the turn. */
const WRITE_LOCK_RETRIES = { retries: 15, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true }
/**
 * A turn holds its lease for as long as it runs — minutes, if the model is slow
 * or a permission prompt is waiting on a person — so this is not a short retry
 * budget but a poll that keeps going until the holder is done or the waiter is
 * stopped.
 */
const TURN_LOCK_RETRIES = { forever: true, factor: 1.2, minTimeout: 200, maxTimeout: 1000, randomize: true }
/**
 * A turn's lease lives beside the record, never on the record's own lock: a turn
 * writes while it holds the lease, so the two must not be the same lock.
 */
const TURN_LOCK_SUFFIX = '.turn.lock'

function turnTarget(file: string): string {
  return `${file}${TURN_LOCK_SUFFIX}`
}

/** proper-lockfile's "somebody else holds this" error. */
function isLocked(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ELOCKED'
}

export interface FileSessionStoreOptions {
  dir: string
  now?: () => number
}

/**
 * Sessions on disk: one JSON file per session, plus a `bindings.json` mapping
 * a transport address to the session bound to it.
 *
 * Writes are atomic (temp file + rename) and serialized through an in-process
 * queue, because the `milo serve` daemon can have several conversations writing
 * at once and `bindings.json` is shared by all of them.
 *
 * The queue only orders writes within this process. Two processes — `milo` and
 * `milo serve`, or two terminals, which both bind `cli:main` — can each hold a
 * copy of the same record, so a turn takes a `SessionLease` for as long as it
 * runs and `save` is a compare-and-save: under an interprocess lock it rereads
 * the stored revision and writes only if it is the one the caller built from.
 * The lease is what stops two turns from interleaving; the version check is the
 * net under it, for a writer that stepped outside a lease.
 */
export class FileSessionStore implements SessionStore {
  private readonly dir: string
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  /** Who holds a session in this process, so a turn waits on its own mutex. */
  private readonly leases = new KeyedMutex()

  constructor(options: FileSessionStoreOptions) {
    this.dir = options.dir
    this.now = options.now ?? Date.now
  }

  async create(): Promise<SessionRecord> {
    return this.run(() => {
      mkdirSync(this.dir, { recursive: true })
      const timestamp = this.now()

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const id = generateNickname((candidate) => existsSync(this.fileFor(candidate)))
        const record = {
          id,
          createdAt: timestamp,
          updatedAt: timestamp,
          messages: [],
          version: INITIAL_SESSION_VERSION,
        } satisfies SessionRecord
        // Creating the file exclusively is what makes the id ours: two `milo`
        // processes picking the same nickname is only a race if nothing claims
        // it, and the write is the claim.
        if (this.claim(record)) return record
      }
      throw new Error('Could not find a free session id')
    })
  }

  /** Writes the record's file only if it does not exist yet. */
  private claim(record: SessionRecord): boolean {
    try {
      writeFileSync(this.fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`, {
        flag: 'wx',
      })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  async load(id: string): Promise<SessionRecord | null> {
    if (!isValidSessionId(id)) return null
    const file = this.fileFor(id)
    if (!existsSync(file)) return null
    try {
      return parseRecord(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      logWarn(`dropping unreadable session ${id}: ${errorMessage(error)}`)
      return null
    }
  }

  async save(record: SessionRecord, expectedVersion: number): Promise<void> {
    if (!isValidSessionId(record.id)) {
      throw new Error(`Invalid session id: ${record.id}`)
    }
    await this.run(async () => {
      mkdirSync(this.dir, { recursive: true })
      const file = this.fileFor(record.id)
      // The lock is what makes read-revision-then-rename one step across
      // processes; without it both writers could read the same revision and
      // both believe they were up to date.
      await this.withLock(file, async () => {
        const actual = this.storedVersion(file)
        if (actual !== expectedVersion) {
          throw new SessionConflictError(record.id, expectedVersion, actual)
        }
        await writeFileAtomic(
          file,
          `${JSON.stringify({ ...record, version: expectedVersion + 1 }, null, 2)}\n`,
        )
      })
    })
  }

  /** The revision on disk; a missing or unreadable file reads as the initial one. */
  private storedVersion(file: string): number {
    if (!existsSync(file)) return INITIAL_SESSION_VERSION
    try {
      return parseRecord(JSON.parse(readFileSync(file, 'utf8')))?.version ?? INITIAL_SESSION_VERSION
    } catch (error) {
      logWarn(`reading the version of ${file} failed: ${errorMessage(error)}`)
      return INITIAL_SESSION_VERSION
    }
  }

  /**
   * Runs `work` while holding the write lock on `file`. A holder that dies
   * without releasing is not a permanent block: `stale` is how long its lock is
   * trusted.
   */
  private async withLock(file: string, work: () => Promise<void>): Promise<void> {
    const release = await this.takeLock(file, WRITE_LOCK_RETRIES)
    try {
      await work()
    } finally {
      await release()
    }
  }

  /**
   * Takes the lock for `target`. `target` is the whole key: proper-lockfile
   * keys its bookkeeping on the path it is given and keeps one entry per path,
   * so a turn's lease must name something other than the record's own path — a
   * turn writes while it holds the lease, and the two would trample each other's
   * entry.
   */
  private async takeLock(
    target: string,
    retries: LockOptions['retries'],
  ): Promise<() => Promise<void>> {
    return lockfile.lock(target, {
      // The path is used as given, so a lock can be held for a record the store
      // is about to write as well as for one that already resolves.
      realpath: false,
      stale: LOCK_STALE_MS,
      retries,
      // Losing a lock is already handled by the version check; the default is to
      // throw from a timer, which would take the process down.
      onCompromised: (error) => logWarn(`lost the lock on ${target}: ${errorMessage(error)}`),
    })
  }

  async tryAcquire(id: string): Promise<SessionLease | null> {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(id)
    // The in-process mutex first: two conversations in this process have no
    // reason to go near the file lock, and taking both would only add latency.
    const unlock = this.leases.tryAcquire(id)
    if (!unlock) return null
    const release = await this.tryTurnLock(file)
    if (!release) {
      unlock()
      return null
    }
    return this.lease(id, release, unlock)
  }

  async acquire(id: string, options?: { signal?: AbortSignal }): Promise<SessionLease> {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(id)
    const unlock = await waitForLease(this.leases.acquire(id), options?.signal)
    let release: () => Promise<void>
    try {
      release = await waitForLease(this.takeLock(turnTarget(file), TURN_LOCK_RETRIES), options?.signal)
    } catch (error) {
      unlock()
      throw error
    }
    return this.lease(id, release, unlock)
  }

  private async lease(
    id: string,
    release: () => Promise<void>,
    unlock: () => void,
  ): Promise<SessionLease> {
    return {
      latest: await this.load(id),
      release: async () => {
        await release()
        unlock()
      },
    }
  }

  /** The turn lock, taken once: null says somebody else holds it. */
  private async tryTurnLock(file: string): Promise<(() => Promise<void>) | null> {
    try {
      return await this.takeLock(turnTarget(file), 0)
    } catch (error) {
      if (isLocked(error)) return null
      throw error
    }
  }

  async list(): Promise<SessionSummary[]> {
    if (!existsSync(this.dir)) return []
    const summaries: SessionSummary[] = []
    for (const entry of readdirSync(this.dir)) {
      if (!entry.endsWith(RECORD_SUFFIX)) continue
      const id = entry.slice(0, -RECORD_SUFFIX.length)
      if (!isValidSessionId(id)) continue
      const record = await this.load(id)
      if (record) summaries.push(toSummary(record))
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async remove(id: string): Promise<void> {
    if (!isValidSessionId(id)) return
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(id)
    if (!existsSync(file)) return
    // Under the turn lease, like a turn: taking it means a removal waits for the
    // turn in flight rather than unlinking the record out from under it, and a
    // save that had already read the revision cannot put the file straight back
    // and make the deletion look like it never happened.
    const unlock = await this.leases.acquire(id)
    try {
      const release = await this.takeLock(turnTarget(file), TURN_LOCK_RETRIES)
      try {
        rmSync(file, { force: true })
      } finally {
        await release()
      }
    } finally {
      unlock()
    }
  }

  async getBinding(scopeKey: string): Promise<string | undefined> {
    const own = this.readBindingFile(this.bindingFile(scopeKey))
    if (own) return own
    // A store written by an older version keeps every binding in one file. Read
    // it, never write it: the first `setBinding` per scope moves that scope on.
    return this.readLegacyBindings()[scopeKey]
  }

  async setBinding(scopeKey: string, id: string): Promise<void> {
    if (!isValidSessionId(id)) return
    await this.run(async () => {
      const file = this.bindingFile(scopeKey)
      mkdirSync(path.dirname(file), { recursive: true })
      await writeFileAtomic(file, `${JSON.stringify(id)}\n`)
    })
  }

  private readBindingFile(file: string): string | undefined {
    if (!existsSync(file)) return undefined
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return typeof value === 'string' && isValidSessionId(value) ? value : undefined
    } catch (error) {
      logWarn(`dropping unreadable binding ${file}: ${errorMessage(error)}`)
      return undefined
    }
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}${RECORD_SUFFIX}`)
  }

  private readLegacyBindings(): Record<string, string> {
    const file = path.join(this.dir, LEGACY_BINDINGS_FILE)
    if (!existsSync(file)) return {}
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && isValidSessionId(value)) out[key] = value
      }
      return out
    } catch (error) {
      logWarn(`dropping unreadable legacy bindings: ${errorMessage(error)}`)
      return {}
    }
  }

  /**
   * A binding lives in its own file, named after the scope. One shared
   * `bindings.json` meant a read-modify-write of the whole map on every turn —
   * which drifts the moment `milo` and `milo serve` run at the same time.
   */
  private bindingFile(scopeKey: string): string {
    const safe = scopeKey.replace(/[^a-zA-Z0-9._-]+/g, '_')
    // A readable name plus a short hash: two different scopes must not collide
    // just because their punctuation sanitized to the same characters.
    const digest = createHash('sha1').update(scopeKey).digest('hex').slice(0, 8)
    return path.join(this.dir, BINDINGS_DIR, `${safe}-${digest}.json`)
  }

  /** Runs `work` after every previously queued write has finished. */
  private run<T>(work: () => T): Promise<T> {
    const next = this.queue.then(work)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

function parseRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<SessionRecord>
  if (typeof raw.id !== 'string' || !Array.isArray(raw.messages)) return null
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now()
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt,
    // A record from before revisions reads as the initial one, so its next save
    // is accepted rather than looking like a conflict with nothing.
    version: typeof raw.version === 'number' ? raw.version : INITIAL_SESSION_VERSION,
    messages: raw.messages as Message[],
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    droppedTokens: typeof raw.droppedTokens === 'number' ? raw.droppedTokens : undefined,
  }
}
