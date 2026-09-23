import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../../util/fs.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import type { Message } from '../providers/types.js'
import { generateNickname } from './nickname.js'
import {
  isValidSessionId,
  toSummary,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
} from './types.js'

const BINDINGS_DIR = 'bindings'
const LEGACY_BINDINGS_FILE = 'bindings.json'
const RECORD_SUFFIX = '.json'

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
 */
export class FileSessionStore implements SessionStore {
  private readonly dir: string
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()

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

  async save(record: SessionRecord): Promise<void> {
    if (!isValidSessionId(record.id)) {
      throw new Error(`Invalid session id: ${record.id}`)
    }
    await this.run(async () => {
      mkdirSync(this.dir, { recursive: true })
      await writeFileAtomic(this.fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`)
    })
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
    await this.run(() => rmSync(this.fileFor(id), { force: true }))
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
    messages: raw.messages as Message[],
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    droppedTokens: typeof raw.droppedTokens === 'number' ? raw.droppedTokens : undefined,
  }
}
