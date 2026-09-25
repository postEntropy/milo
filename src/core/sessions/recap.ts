import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { ensurePrivateDir, writePrivateFile } from '../../util/fs.js'
import { isValidSessionId } from './types.js'

/**
 * What a session was about, in a few bullets.
 *
 * Derived from a transcript — and deliberately kept out of it. A transcript is
 * written one turn at a time by the session that owns it; a recap written into
 * the same record is a second writer to that record, and one of the two loses.
 * Apart, a recap cannot damage anything: the worst it can be is wrong, and
 * `sourceUpdatedAt` is how a reader tells a wrong one to ignore.
 */
export interface SessionRecap {
  /** The session this describes (`calm-otter-7`). */
  session: string
  /** The bullets themselves. */
  text: string
  /** The transcript's `updatedAt` this was written from. */
  sourceUpdatedAt: number
  /** When it was written. */
  at: number
}

export interface RecapStore {
  read(id: string): Promise<SessionRecap | null>
  /**
   * Writes the recap unless one describing a transcript at least as new is
   * already stored. Producing a recap takes a model call, so by the time one
   * lands another process may have left a fresher one; replacing that would take
   * bullets out of `/sessions` until the next switch rewrites them. The store
   * decides, right before the write, so no caller can get it wrong. A recap only
   * moves forward.
   */
  write(recap: SessionRecap): Promise<void>
  remove(id: string): Promise<void>
}

export interface FileRecapStoreOptions {
  dir: string
}

/**
 * Recaps on disk, one JSON file per session under `sessions/recaps/`. They are
 * derived and disposable: a recap that cannot be read is simply absent, so a
 * corrupt one costs a listing its bullets and nothing else.
 */
export class FileRecapStore implements RecapStore {
  private readonly dir: string

  constructor(options: FileRecapStoreOptions) {
    this.dir = options.dir
  }

  async read(id: string): Promise<SessionRecap | null> {
    if (!isValidSessionId(id)) return null
    try {
      return parseRecap(JSON.parse(readFileSync(this.fileFor(id), 'utf8')))
    } catch {
      return null
    }
  }

  async write(recap: SessionRecap): Promise<void> {
    if (!isValidSessionId(recap.session)) return
    const existing = await this.read(recap.session)
    if (existing && existing.sourceUpdatedAt >= recap.sourceUpdatedAt) return
    ensurePrivateDir(this.dir)
    await writePrivateFile(this.fileFor(recap.session), `${JSON.stringify(recap, null, 2)}\n`)
  }

  async remove(id: string): Promise<void> {
    if (!isValidSessionId(id)) return
    rmSync(this.fileFor(id), { force: true })
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }
}

/** Recaps in RAM. The default when none is configured, as for sessions. */
export class MemoryRecapStore implements RecapStore {
  private readonly recaps = new Map<string, SessionRecap>()

  async read(id: string): Promise<SessionRecap | null> {
    return this.recaps.get(id) ?? null
  }

  async write(recap: SessionRecap): Promise<void> {
    // The same rule the file store enforces: a recap never replaces a newer one.
    const existing = this.recaps.get(recap.session)
    if (existing && existing.sourceUpdatedAt >= recap.sourceUpdatedAt) return
    this.recaps.set(recap.session, recap)
  }

  async remove(id: string): Promise<void> {
    this.recaps.delete(id)
  }
}

function parseRecap(value: unknown): SessionRecap | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<SessionRecap>
  if (typeof raw.session !== 'string' || typeof raw.text !== 'string') return null
  if (typeof raw.sourceUpdatedAt !== 'number') return null
  return {
    session: raw.session,
    text: raw.text,
    sourceUpdatedAt: raw.sourceUpdatedAt,
    at: typeof raw.at === 'number' ? raw.at : raw.sourceUpdatedAt,
  }
}
