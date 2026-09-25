import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { ensurePrivateDir, PRIVATE_FILE_MODE } from '../../util/fs.js'
import { readLegacyMemory } from './migrate.js'
import { tokenize } from './tokenize.js'
import {
  scopeKey,
  type Memory,
  type MemoryInput,
  type MemoryItem,
  type MemoryLayer,
  type MemoryScope,
  type MemoryStatus,
} from './types.js'

const DB_FILE = 'memory.db'
const MIGRATED_KEY = 'migrated_json_v1'

/** Raw turns kept per conversation scope. Facts are never evicted. */
export const DEFAULT_KEEP_SAID = 500

/**
 * One database for every conversation, `id` doubling as the FTS5 rowid. The
 * table is the source of truth; the FTS index is derived from it by trigger, so
 * a second index (embeddings, one day) can be added the same way without the
 * rows moving.
 */
const SCHEMA = `
create table if not exists memories (
  id         integer primary key,
  uid        text not null unique,
  scope      text not null,
  text       text not null,
  kind       text not null check (kind in ('fact','said')),
  tags       text not null default '[]',
  created_at integer not null,
  hash       text not null
);
create unique index if not exists memories_scope_hash on memories(scope, hash);
create index if not exists memories_scope_kind on memories(scope, kind, created_at desc);

-- \`remove_diacritics 2\` is what makes "voce" find "você", which in Portuguese
-- is most of the difference between a store that works and one that does not.
create virtual table if not exists memories_fts using fts5(
  text,
  content='memories',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

create trigger if not exists memories_ai after insert on memories begin
  insert into memories_fts(rowid, text) values (new.id, new.text);
end;

create trigger if not exists memories_ad after delete on memories begin
  insert into memories_fts(memories_fts, rowid, text) values ('delete', old.id, old.text);
end;

create trigger if not exists memories_au after update on memories begin
  insert into memories_fts(memories_fts, rowid, text) values ('delete', old.id, old.text);
  insert into memories_fts(rowid, text) values (new.id, new.text);
end;

create table if not exists meta (key text primary key, value text not null);
`

type SqliteModule = typeof import('node:sqlite')

let engine: SqliteModule | null = null

/**
 * Loads the engine, and takes over warning printing on the way in.
 *
 * `node:sqlite` is still experimental on Node 22 and 24 and prints an
 * `ExperimentalWarning` the first time it is touched — which lands on stderr,
 * above the terminal UI. Node's own printer is replaced by one that stays quiet
 * about this single line and re-prints everything else, so a real deprecation
 * still reaches the person.
 *
 * That has to happen *before* the engine is loaded, which is why the module is
 * required here rather than imported at the top. The driver sits behind this one
 * function on purpose: if the warning ever stops being acceptable,
 * `better-sqlite3` is this function and no caller changes.
 */
function loadSqlite(): SqliteModule {
  if (engine) return engine

  process.removeAllListeners('warning')
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return
    console.error(`${warning.name}: ${warning.message}`)
  })

  engine = createRequire(import.meta.url)('node:sqlite') as SqliteModule
  return engine
}

export const sqliteMemoryFile = (dir: string): string => path.join(dir, DB_FILE)

export interface SqliteMemoryOptions {
  dir: string
  keepSaid?: number
  debug?: boolean
}

interface Row {
  uid: string
  text: string
  createdAt: number
  tags: string
}

/**
 * The one query recall runs.
 *
 * `cross join` is load-bearing, not style. With a plain join and no
 * `sqlite_stat1` — which is the state of a store that has only ever been written
 * to — the planner drives from `memories` and probes the virtual table once per
 * row: measured at 53 ms per recall on 500 entries, against 0.6 ms when the FTS
 * index drives and each row is fetched by rowid. Pinning the order is what makes
 * it right without depending on statistics that would have to be refreshed and
 * would be wrong again the week they went stale.
 *
 * Exported because nothing observable tells those two plans apart: there is no
 * behaviour to assert, so the test reads this query's own query plan.
 */
export const RECALL_SQL = `
  select m.uid as uid, m.text as text, m.created_at as createdAt, m.tags as tags
    from memories_fts
    cross join memories m on m.id = memories_fts.rowid
   where memories_fts match ?
     and m.scope = ?
     and m.kind = ?
   order by bm25(memories_fts), m.created_at desc
   limit ?
`

export class SqliteMemory implements Memory {
  private readonly db: DatabaseSync
  private readonly location: string
  private readonly keepSaid: number
  private readonly debug: boolean
  private readonly insertStmt: StatementSync
  private readonly evictStmt: StatementSync
  private readonly selectStmt: StatementSync

  constructor(options: SqliteMemoryOptions) {
    const { DatabaseSync } = loadSqlite()

    ensurePrivateDir(options.dir)
    this.location = sqliteMemoryFile(options.dir)
    this.db = new DatabaseSync(this.location)
    this.keepSaid = options.keepSaid ?? DEFAULT_KEEP_SAID
    this.debug = options.debug ?? process.env.MILO_DEBUG === '1'

    // WAL, because the CLI and `milo serve` are two processes on one store and
    // the default rollback journal would make one of them wait on the other.
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.tighten()

    this.insertStmt = this.db.prepare(`
      insert into memories (uid, scope, text, kind, tags, created_at, hash)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(scope, hash) do update set
        created_at = excluded.created_at,
        kind = case when excluded.kind = 'fact' then 'fact' else memories.kind end
    `)
    // The same fact said twice is then one memory. `created_at` is touched so
    // recency still works; a later raw turn never demotes a saved fact, because
    // the case above only ever promotes.
    this.evictStmt = this.db.prepare(`
      delete from memories
       where scope = ? and kind = 'said'
         and id not in (
           select id from memories
            where scope = ? and kind = 'said'
            order by created_at desc, id desc
            limit ?
         )
    `)
    this.selectStmt = this.db.prepare(RECALL_SQL)

    this.migrate()
  }

  async remember(scope: MemoryScope, items: MemoryInput[]): Promise<void> {
    const entries = items
      .map((item) => ({ ...item, text: item.text.trim() }))
      .filter((item) => item.text.length > 0)
    if (entries.length === 0) return

    const key = scopeKey(scope)
    this.transaction(() => {
      this.write(key, entries)
      this.evictStmt.run(key, key, this.keepSaid)
    })

    if (this.debug) console.error(`[memory] remember ${key}: +${entries.length}`)
  }

  async recall(
    scope: MemoryScope,
    query: string,
    opts?: { limit?: number },
  ): Promise<MemoryItem[]> {
    const limit = opts?.limit ?? 5
    const match = toMatchQuery(query)
    if (!match) return []

    const key = scopeKey(scope)
    // Facts first, then raw turns filling what is left. Relevance orders each
    // layer — `bm25` is the whole reason for the index — and recency breaks its
    // ties, which is most of them on a small corpus.
    const items = [
      ...this.select(key, 'fact', match, limit),
      ...this.select(key, 'said', match, limit),
    ]
      .slice(0, limit)
      .map((row, index) => ({
        id: row.uid,
        text: row.text,
        createdAt: Number(row.createdAt),
        tags: parseTags(row.tags),
        score: 1 / (1 + index),
      }))

    if (this.debug) {
      console.error(`[memory] recall ${key} "${query.slice(0, 40)}": ${items.length} hit(s)`)
    }
    return items
  }

  /** For tests and shutdown: nothing else needs the handle. */
  close(): void {
    this.db.close()
  }

  private select(scope: string, kind: MemoryLayer, match: string, limit: number): Row[] {
    try {
      return this.selectStmt.all(match, scope, kind, limit) as unknown as Row[]
    } catch {
      // Recall is on the path of every turn, so it is allowed to answer nothing
      // and is never allowed to take the turn down: a store that cannot be read
      // — locked by the other process, or damaged — costs one reply's context.
      return []
    }
  }

  private write(scope: string, items: (MemoryInput & { createdAt?: number })[]): void {
    for (const item of items) {
      this.insertStmt.run(
        randomUUID(),
        scope,
        item.text,
        item.kind ?? 'fact',
        JSON.stringify(item.tags ?? []),
        item.createdAt ?? Date.now(),
        hashOf(item.text),
      )
    }
  }

  /**
   * Brings across what `FileMemory` left on disk, once per store. Guarded by a
   * row in `meta`, and non-destructive: the JSON files stay where they are, so
   * `backend: "file"` still reads them.
   */
  private migrate(): void {
    const done = this.db.prepare('select value from meta where key = ?').get(MIGRATED_KEY)
    if (done) return

    const legacy = readLegacyMemory(path.dirname(this.location))
    const total = legacy.reduce((sum, entry) => sum + entry.items.length, 0)

    this.transaction(() => {
      for (const entry of legacy) this.write(entry.scope, entry.items)
      this.db
        .prepare('insert or replace into meta (key, value) values (?, ?)')
        .run(MIGRATED_KEY, new Date().toISOString())
    })

    if (this.debug && total > 0) {
      console.error(
        `[memory] migrated ${total} item(s) from ${legacy.length} JSON file(s); they are left in place`,
      )
    }
  }

  private tighten(): void {
    // The directory is 0700, which is what covers the `-wal` and `-shm`
    // siblings; the database is tightened too, because a file left to the umask
    // is readable by every account on the machine.
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${this.location}${suffix}`
      if (existsSync(file)) chmodSync(file, PRIVATE_FILE_MODE)
    }
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

/** What the setup screen shows: read straight off the file, no instance needed. */
export function sqliteMemoryStatus(location: string): MemoryStatus {
  const empty: MemoryStatus = {
    backend: 'sqlite',
    location,
    scopes: 0,
    facts: 0,
    said: 0,
    bytes: 0,
  }
  if (!existsSync(location)) return empty

  let db: DatabaseSync | undefined
  try {
    db = new (loadSqlite().DatabaseSync)(location)
    const counts = db
      .prepare(
        `select count(distinct scope) as scopes,
                sum(kind = 'fact') as facts,
                sum(kind = 'said') as said
           from memories`,
      )
      .get() as { scopes: number; facts: number | null; said: number | null }
    return {
      ...empty,
      scopes: Number(counts.scopes ?? 0),
      facts: Number(counts.facts ?? 0),
      said: Number(counts.said ?? 0),
      bytes: sizeOnDisk(location),
    }
  } catch {
    // A file that is not a store of ours is reported as empty rather than
    // throwing inside a settings screen.
    return { ...empty, bytes: sizeOnDisk(location) }
  } finally {
    db?.close()
  }
}

function sizeOnDisk(location: string): number {
  return ['', '-wal'].reduce((sum, suffix) => {
    try {
      return sum + statSync(`${location}${suffix}`).size
    } catch {
      return sum
    }
  }, 0)
}

/**
 * A person's sentence is not an FTS5 query — but by this point it is: `tokenize`
 * splits on everything that is not a letter or a digit, so what arrives here is
 * plain words, and the `OR` between them means none of them is ever in the
 * infix position where `NEAR` or `NOT` would become an operator. Verified against
 * the engine rather than assumed: `alpha NEAR omega`, `omega NOT alpha` and a
 * query made only of `not` all behave as ordinary terms.
 *
 * The words are OR-ed, so the answer stays "anything sharing a word", which is
 * the same promise `FileMemory` made. An empty query is no query at all.
 */
function toMatchQuery(query: string): string | null {
  const tokens = [...tokenize(query)]
  if (tokens.length === 0) return null
  return tokens.join(' OR ')
}

/** Case and spacing are not a difference: the same note saved twice is one row. */
function hashOf(text: string): string {
  return createHash('sha1').update(text.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex')
}

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}
