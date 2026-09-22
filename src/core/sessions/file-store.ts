import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Message } from '../providers/types.js'
import { generateNickname } from './nickname.js'
import {
  isValidSessionId,
  toSummary,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
} from './types.js'

const BINDINGS_FILE = 'bindings.json'
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
      const id = generateNickname((candidate) => existsSync(this.fileFor(candidate)))
      const timestamp = this.now()
      return {
        id,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [],
      } satisfies SessionRecord
    })
  }

  async load(id: string): Promise<SessionRecord | null> {
    if (!isValidSessionId(id)) return null
    const file = this.fileFor(id)
    if (!existsSync(file)) return null
    try {
      return parseRecord(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return null
    }
  }

  async save(record: SessionRecord): Promise<void> {
    if (!isValidSessionId(record.id)) {
      throw new Error(`Invalid session id: ${record.id}`)
    }
    await this.run(() => {
      this.writeAtomic(this.fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`)
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
    return this.readBindings()[scopeKey]
  }

  async setBinding(scopeKey: string, id: string): Promise<void> {
    await this.run(() => {
      const bindings = this.readBindings()
      bindings[scopeKey] = id
      this.writeAtomic(
        path.join(this.dir, BINDINGS_FILE),
        `${JSON.stringify(bindings, null, 2)}\n`,
      )
    })
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}${RECORD_SUFFIX}`)
  }

  private readBindings(): Record<string, string> {
    const file = path.join(this.dir, BINDINGS_FILE)
    if (!existsSync(file)) return {}
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && isValidSessionId(value)) out[key] = value
      }
      return out
    } catch {
      return {}
    }
  }

  private writeAtomic(file: string, content: string): void {
    mkdirSync(this.dir, { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, content)
    renameSync(temp, file)
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
