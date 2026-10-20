/**
 * When each session was last looked at — the watermark its unread mark counts
 * from.
 *
 * A listing can say whether a session moved after this moment, but nothing in the
 * transcript can say when the person read it: an answer written by a routine
 * while no screen was open leaves exactly the same trace as one they watched.
 * The moment is Milo's own state, so it is kept in one file beside the sessions
 * rather than in a record — writing it into the transcript would bump the record's
 * revision and fight the turn lease over a read that changed nothing.
 *
 * It is install-wide, because the install belongs to one person: opening a
 * session on the phone is looking at it, and the browser is not owed the mark.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionSeenFile } from '../config/paths.js'
import { logWarn } from '../../util/log.js'

export interface SessionSeen {
  /** When each session was last looked at, by id. Empty when none ever was. */
  all(): ReadonlyMap<string, number>
  /**
   * The map as it stands, with an entry added for any of these sessions that has
   * none: the line an install without a look of its own starts from. Without it the
   * whole history would read as unread at once — and a session a delivery moved
   * before it was ever opened would never read as unread at all, since no mark of
   * its own would ever appear. Nothing already recorded is touched.
   */
  seed(sessions: ReadonlyArray<{ id: string; updatedAt: number }>): ReadonlyMap<string, number>
  /**
   * Records that a session was looked at, now unless a moment is given. The
   * watermark never moves backwards: two surfaces racing to mark the same session
   * leave it at the later of the two.
   */
  mark(id: string, at?: number): void
  /** Drops a session's mark with the session itself. */
  forget(id: string): void
}

/**
 * The install's file: `session-seen.json`, private like everything the person
 * typed, written whole through a temporary neighbour so a crash leaves the
 * previous map rather than half of one. It holds ids and moments, never words.
 */
export class FileSessionSeen implements SessionSeen {
  all(): ReadonlyMap<string, number> {
    return new Map(read())
  }

  seed(sessions: ReadonlyArray<{ id: string; updatedAt: number }>): ReadonlyMap<string, number> {
    const map = read() ?? new Map()
    let added = false
    for (const session of sessions) {
      if (map.has(session.id)) continue
      map.set(session.id, session.updatedAt)
      added = true
    }
    if (added) write(map)
    return map
  }

  mark(id: string, at = Date.now()): void {
    const map = read() ?? new Map()
    const looked = map.get(id)
    if (looked !== undefined && looked >= at) return
    map.set(id, at)
    write(map)
  }

  forget(id: string): void {
    const map = read()
    if (!map?.delete(id)) return
    write(map)
  }
}

/** The same map in memory, for a test that does not want a file. */
export class MemorySessionSeen implements SessionSeen {
  private readonly marks = new Map<string, number>()

  all(): ReadonlyMap<string, number> {
    return new Map(this.marks)
  }

  seed(sessions: ReadonlyArray<{ id: string; updatedAt: number }>): ReadonlyMap<string, number> {
    for (const session of sessions) {
      if (!this.marks.has(session.id)) this.marks.set(session.id, session.updatedAt)
    }
    return this.all()
  }

  mark(id: string, at = Date.now()): void {
    const looked = this.marks.get(id)
    if (looked !== undefined && looked >= at) return
    this.marks.set(id, at)
  }

  forget(id: string): void {
    this.marks.delete(id)
  }
}

/**
 * The file's own map, or null when it has never been written. A file that cannot
 * be read as a map is reported and read as absent rather than taking the session
 * list down with it — the direction of the failure is a mark that does not show,
 * not a sidebar that does not open.
 */
function read(): Map<string, number> | null {
  let raw: string
  try {
    raw = readFileSync(sessionSeenFile(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const map = new Map<string, number>()
    for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) map.set(id, at)
    }
    return map
  } catch (error) {
    logWarn(`could not read ${sessionSeenFile()}: ${(error as Error).message}`)
    return null
  }
}

function write(map: ReadonlyMap<string, number>): void {
  const file = sessionSeenFile()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(Object.fromEntries(map), null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
  chmodSync(file, 0o600)
}
