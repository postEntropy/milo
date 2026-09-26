import { closeSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { errorMessage } from '../../util/errors.js'
import { ensurePrivateDir } from '../../util/fs.js'
import { logWarn } from '../../util/log.js'
import { dayOf, type HistoryEntry } from '../history.js'
import { hashOf, loadSqlite, tightenDb, toMatchQuery } from './sql.js'
import type { MemoryItem, MemoryScope, TurnSource } from './types.js'

const DB_FILE = 'turns.db'
const FILE_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/

/**
 * An index of what the person typed, read out of the history log.
 *
 * The log is the record — every turn this install ever took, both sides of it,
 * plain text, and nothing here is the truth about it. This is a **derived**
 * index: delete the file and the next pass reads it back off the log, which is
 * why it can be thrown away when it cannot be opened rather than refused.
 *
 * Why it exists: recall runs before every turn and answers from the person's own
 * words, and the log is 20 to 50 times too slow to read for that (measured: 2.6
 * to 4.7 ms walking 309 entries against 0.09 to 0.13 ms answering the same
 * questions from an FTS index). With the index, recall reaches the whole history
 * — every session, every gateway, every day — instead of a capped copy of it.
 *
 * Only what the person said goes in. Replies are reachable through
 * `search_history`, which reads the log itself; what recall is answering is
 * "what did I say", and indexing both sides would double the file to answer a
 * question nobody asks it.
 */
const SCHEMA = `
create table if not exists turns (
  id      integer primary key,
  at      text not null,
  session text not null,
  scope   text not null,
  text    text not null,
  hash    text not null unique
);
create index if not exists turns_at on turns(at desc);

-- \`remove_diacritics 2\` for the same reason as the facts store: it is what makes
-- "voce" find "você", which in Portuguese is most of the difference between a
-- search that works and one that does not.
create virtual table if not exists turns_fts using fts5(
  text,
  content='turns',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

create trigger if not exists turns_ai after insert on turns begin
  insert into turns_fts(rowid, text) values (new.id, new.text);
end;

create trigger if not exists turns_ad after delete on turns begin
  insert into turns_fts(turns_fts, rowid, text) values ('delete', old.id, old.text);
end;

create trigger if not exists turns_au after update on turns begin
  insert into turns_fts(turns_fts, rowid, text) values ('delete', old.id, old.text);
  insert into turns_fts(rowid, text) values (new.id, new.text);
end;

-- How many bytes of each day-file are already in here. The log only ever grows at
-- its end, so a pass reads what was appended and nothing else: re-reading the
-- current day's file on every question would be a stall nobody could explain.
create table if not exists files (name text primary key, offset integer not null);
`

/**
 * The one query a turn is recalled with.
 *
 * `cross join` is load-bearing, exactly as it is in the facts store: without
 * pinned order the planner drives from `turns` and probes the virtual table once
 * per row, which is half a second per recall on a log of any size.
 */
export const TURNS_SQL = `
  select t.hash as uid, t.text as text, t.at as at
    from turns_fts
    cross join turns t on t.id = turns_fts.rowid
   where turns_fts match ?
   order by bm25(turns_fts), t.at desc
   limit ?
`

interface TurnRow {
  uid: string
  text: string
  at: string
}

export const turnIndexFile = (dir: string): string => path.join(dir, DB_FILE)

export interface TurnIndexOptions {
  /** The directory the history log lives in. */
  dir: string
  /**
   * How many days back a turn is worth indexing. A recency window rather than a
   * cap: older days are dropped as they fall out, so the store stays bounded
   * while still reaching further back than the row cap it replaced. `0` keeps
   * every day.
   */
  windowDays?: number
  debug?: boolean
}

export class TurnIndex implements TurnSource {
  private readonly db: DatabaseSync
  private readonly location: string
  private readonly dir: string
  private readonly windowDays: number
  private readonly debug: boolean
  private readonly insertStmt: StatementSync
  private readonly fileStmt: StatementSync
  private readonly markStmt: StatementSync
  private readonly selectStmt: StatementSync
  private readonly pruneStmt: StatementSync
  /** One line per process is enough for a log that cannot be read. */
  private warned = false

  constructor(options: TurnIndexOptions) {
    const { DatabaseSync } = loadSqlite()

    ensurePrivateDir(options.dir)
    this.dir = options.dir
    this.windowDays = Math.max(0, options.windowDays ?? 0)
    this.location = turnIndexFile(options.dir)
    this.debug = options.debug ?? process.env.MILO_DEBUG === '1'

    // Derived, so a file that cannot be opened is deleted rather than refused:
    // everything in it can be read back off the log. Without this a damaged
    // index would cost recall forever, one line in a log nobody reads.
    try {
      this.db = openDatabase(this.location, DatabaseSync)
    } catch {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${this.location}${suffix}`, { force: true })
      this.db = openDatabase(this.location, DatabaseSync)
    }
    tightenDb(this.location)

    this.insertStmt = this.db.prepare(`
      insert into turns (at, session, scope, text, hash)
      values (?, ?, ?, ?, ?)
      on conflict(hash) do update set
        at = excluded.at,
        session = excluded.session,
        scope = excluded.scope
      where excluded.at > turns.at
    `)
    // The same sentence said twice is one row, and the newer telling wins: the
    // second copy is not new information, and a store of "ok" repeated two
    // hundred times is a store that answers "ok" to everything. When it was said
    // is what `search_history` reads the log for.
    this.fileStmt = this.db.prepare('select offset from files where name = ?')
    this.markStmt = this.db.prepare('insert or replace into files (name, offset) values (?, ?)')
    this.selectStmt = this.db.prepare(TURNS_SQL)
    this.pruneStmt = this.db.prepare('delete from turns where at < ?')

    this.sync()
  }

  async recall(
    _scope: MemoryScope,
    query: string,
    opts?: { limit?: number },
  ): Promise<MemoryItem[]> {
    const match = toMatchQuery(query)
    if (!match) return []
    const limit = opts?.limit ?? 5

    try {
      // Before the read, not on a timer: the log is appended by this process or
      // the other one, and a question asked now should see what was typed a
      // moment ago. A pass with nothing new behind it is one `stat` per day-file.
      this.sync()
      const rows = this.selectStmt.all(match, limit) as unknown as TurnRow[]
      return rows.map((row, index) => ({
        id: row.uid,
        text: row.text,
        createdAt: Date.parse(row.at) || 0,
        tags: ['user'],
        score: 1 / (1 + index),
      }))
    } catch (error) {
      // Same rule as the facts store: recall is on the path of every turn, so it
      // may answer nothing and may never take the turn down.
      this.warnOnce(`could not read the history: ${errorMessage(error)}`)
      return []
    }
  }

  /** For tests and shutdown: nothing else needs the handle. */
  close(): void {
    this.db.close()
  }

  /**
   * Drops every turn older than `iso`. The window calls this as it slides, and
   * `milo history trim` calls it after deleting day-files, so a turn from a day
   * that is gone cannot come back as a recall.
   */
  pruneBefore(iso: string): number {
    try {
      return Number(this.pruneStmt.run(iso).changes ?? 0)
    } catch (error) {
      // Recall rides every turn: a prune that cannot run is a line in the log,
      // never a turn taken down.
      this.warnOnce(`could not prune the history index: ${errorMessage(error)}`)
      return 0
    }
  }

  /** The oldest day the window keeps, as a day-file name and an ISO instant. */
  private cutoff(): { file: string; iso: string } | null {
    if (this.windowDays <= 0) return null
    const from = new Date(Date.now() - this.windowDays * 24 * 60 * 60 * 1000)
    return { file: `${dayOf(from)}.jsonl`, iso: from.toISOString() }
  }

  /**
   * Brings the index up to what is on disk.
   *
   * Per file: if the recorded offset is past the file's size the file was
   * replaced or truncated, so it is read from the top; otherwise only the bytes
   * after the offset are. A trailing line without its newline yet — a turn being
   * written right now — is left for the next pass rather than parsed as a broken
   * entry.
   */
  private sync(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
        .filter((name) => FILE_NAME.test(name))
        .sort()
    } catch {
      return // No log yet. Nothing is written here that could be missed.
    }

    // The window is a date: a day-file named older than it is not read, and any
    // row that outlived it — from a pass made before the window narrowed — is
    // dropped. The name sorts as a date, so comparing it is a string compare.
    const cutoff = this.cutoff()
    if (cutoff) this.pruneBefore(cutoff.iso)

    for (const name of names) {
      if (cutoff && name < cutoff.file) continue
      const file = path.join(this.dir, name)
      let size: number
      try {
        size = statSync(file).size
      } catch {
        continue
      }

      const recorded = (this.fileStmt.get(name) as { offset: number } | undefined)?.offset ?? 0
      const offset = recorded > size ? 0 : recorded
      if (offset === size) continue

      let chunk: Buffer
      try {
        chunk = readBytes(file, offset, size)
      } catch {
        continue
      }
      const end = chunk.lastIndexOf(0x0a) // '\n'
      if (end < 0) continue

      this.index(name, chunk.subarray(0, end + 1).toString('utf8'), offset + end + 1)
    }
  }

  /** One pass of a whole number of lines: the rows go in, or the offset does not move. */
  private index(name: string, chunk: string, offset: number): void {
    const rows: { at: string; session: string; scope: string; text: string; hash: string }[] = []
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue
      let entry: HistoryEntry
      try {
        entry = JSON.parse(line) as HistoryEntry
      } catch {
        // Torn by a crash mid-append. It is already past, and the offset still
        // moves: stopping here would block every later line behind it.
        continue
      }
      if (entry.kind !== 'user') continue
      const text = entry.text?.trim()
      if (!text) continue
      rows.push({
        at: entry.at ?? '',
        session: entry.session ?? '',
        scope: entry.scope ?? '',
        text,
        hash: hashOf(text),
      })
    }
    if (rows.length === 0) {
      this.markStmt.run(name, offset)
      return
    }

    this.transaction(() => {
      for (const row of rows) {
        this.insertStmt.run(row.at, row.session, row.scope, row.text, row.hash)
      }
      this.markStmt.run(name, offset)
    })
    if (this.debug) console.error(`[memory] indexed ${rows.length} turn(s) from ${name}`)
  }

  private warnOnce(message: string): void {
    if (this.warned) return
    this.warned = true
    logWarn(`${message} — recall keeps to the facts it has`)
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('begin')
    try {
      const result = run()
      this.db.exec('commit')
      return result
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }
}

function openDatabase(location: string, DatabaseSync: typeof import('node:sqlite').DatabaseSync) {
  const db = new DatabaseSync(location)
  // WAL, because the CLI and `milo serve` both append to the log and both index
  // it; the default rollback journal would make one of them wait on the other.
  db.exec('pragma journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

/** The bytes from `from` to `to`, which is how a growing file is caught up with. */
function readBytes(file: string, from: number, to: number): Buffer {
  const length = to - from
  if (length <= 0) return Buffer.alloc(0)

  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, from)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}
