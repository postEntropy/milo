import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { errorMessage } from '../../util/errors.js'
import { ensurePrivateDir } from '../../util/fs.js'
import { logWarn } from '../../util/log.js'
import { InputRefusedError, isNoise, type Embedder } from './embed.js'
import { keepCovered } from './coverage.js'
import { readLegacyMemory } from './migrate.js'
import { hashOf, loadSqlite, sizeOnDisk, tightenDb, toMatchQuery } from './sql.js'
import { contentWords } from './tokenize.js'
import {
  INSTALL_SCOPE,
  scopeKey,
  type Memory,
  type MemoryInput,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
} from './types.js'

const DB_FILE = 'memory.db'
const MIGRATED_KEY = 'migrated_json_v1'
const UNIFIED_KEY = 'unified_scope_v1'
const EMBEDDED_KEY = 'embed_model'

/** How many notes are embedded in one request while filling the store in. */
const EMBED_BATCH = 64

/**
 * What is sent to be embedded. A note is a sentence; a turn can be a pasted log,
 * and the smallest model around takes 512 tokens and refuses the whole request
 * over it — measured live, 1,803 tokens for a 6,720-character turn, and 729 for a
 * 1,500-character one, because text that reads as noise tokenizes worse than
 * prose. At the worst rate seen, about two characters per token, this stays
 * under that ceiling with room — and it costs the default hosted model nothing,
 * which takes thirty-two thousand. The head is what a question refers to anyway.
 */
const EMBED_CHARS = 900

/** How many notes `/memory` shows when the surface does not ask for a number. */
export const DEFAULT_LIST_LIMIT = 50

/**
 * One database of facts, `id` doubling as the FTS5 rowid. The table is the source
 * of truth; the FTS index is derived from it by trigger, so a second index
 * (embeddings) was added the same way without the rows moving.
 *
 * What the person typed is *not* here. It is in the history log, which is the
 * record of every turn this install ever took, and recall reads it from there
 * (`turns.ts`). Keeping a copy in here as well meant the same sentence in two
 * places, one of them capped and both able to drift.
 */
const SCHEMA = `
create table if not exists memories (
  id         integer primary key,
  uid        text not null unique,
  scope      text not null,
  text       text not null,
  tags       text not null default '[]',
  created_at integer not null,
  hash       text not null,
  -- Unit-length, little-endian float32. Null until the embedder has seen it.
  vector     blob
);
create unique index if not exists memories_scope_hash on memories(scope, hash);
create index if not exists memories_scope_created on memories(scope, created_at desc);

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

export const sqliteMemoryFile = (dir: string): string => path.join(dir, DB_FILE)

export interface SqliteMemoryOptions {
  dir: string
  debug?: boolean
  /**
   * Turns text into vectors, so recall can also match by meaning. Absent — the
   * usual case — is a store that works on words alone, exactly as it always has.
   */
  embedder?: Embedder
  /**
   * Whether the reply is trimmed to the notes that carry the question
   * (`coverage.ts`). On by default. Off is the untrimmed ranking it replaced,
   * kept reachable so the two can be measured against each other rather than
   * argued about.
   */
  coverage?: boolean
}

interface Row {
  uid: string
  text: string
  createdAt: number
  tags: string
}

interface VectorRow extends Row {
  vector: Uint8Array | null
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
   order by bm25(memories_fts), m.created_at desc
   limit ?
`

export class SqliteMemory implements Memory {
  private readonly db: DatabaseSync
  private readonly location: string
  private readonly debug: boolean
  private readonly insertStmt: StatementSync
  private readonly selectStmt: StatementSync
  private readonly listStmt: StatementSync
  private readonly forgetStmt: StatementSync
  private readonly factTextStmt: StatementSync
  private readonly touchStmt: StatementSync
  private readonly vectorStmt: StatementSync
  private readonly setVectorStmt: StatementSync
  private readonly embedder?: Embedder
  private readonly coverage: boolean
  /** The fill-in, once per process. Nothing waits on it. */
  private filling: Promise<void> | null = null
  /** One line per process is enough for an engine that is simply not up. */
  private warned = false

  constructor(options: SqliteMemoryOptions) {
    const { DatabaseSync } = loadSqlite()

    ensurePrivateDir(options.dir)
    this.location = sqliteMemoryFile(options.dir)
    this.db = new DatabaseSync(this.location)
    this.debug = options.debug ?? process.env.MILO_DEBUG === '1'
    this.embedder = options.embedder
    this.coverage = options.coverage ?? true

    // WAL, because the CLI and `milo serve` are two processes on one store and
    // the default rollback journal would make one of them wait on the other.
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.addVectorColumn()
    tightenDb(this.location)

    this.insertStmt = this.db.prepare(`
      insert into memories (uid, scope, text, tags, created_at, hash)
      values (?, ?, ?, ?, ?, ?)
      on conflict(scope, hash) do update set
        created_at = excluded.created_at
    `)
    // The same fact said twice is then one memory, with `created_at` touched so
    // recency still works.
    this.selectStmt = this.db.prepare(RECALL_SQL)
    this.listStmt = this.db.prepare(`
      select uid, text, created_at as createdAt, tags
        from memories
       where scope = ?
       order by created_at desc, id desc
       limit ?
    `)
    this.forgetStmt = this.db.prepare('delete from memories where uid = ? and scope = ?')
    // Bounded: this is the comparison set for a fact about to be written, and a
    // store cannot grow a fact layer big enough for a full scan to matter.
    this.factTextStmt = this.db.prepare(
      `select uid, text from memories
        where scope = ?
        order by created_at desc, id desc
        limit 200`,
    )
    this.touchStmt = this.db.prepare('update memories set created_at = ? where uid = ? and scope = ?')
    // Every vector of one layer, for the semantic side of a recall. A full scan
    // is the right shape at this size — measured at 2.5 ms over 5,000 notes of
    // 384 dimensions, against the milliseconds a vector index would add to every
    // write. The day a store is big enough for that to be wrong, this is the one
    // statement that changes.
    this.vectorStmt = this.db.prepare(
      `select uid, text, created_at as createdAt, tags, vector
         from memories
        where scope = ? and vector is not null`,
    )
    this.setVectorStmt = this.db.prepare('update memories set vector = ? where uid = ?')

    this.migrate()
    this.unify()
    // Started here and left: filling the store in is a model call per batch, and
    // the first turn after enabling this must not wait for the whole history.
    void this.ensureVectors()
  }

  async remember(scope: MemoryScope, items: MemoryInput[]): Promise<void> {
    const entries = items
      .map((item) => ({ ...item, text: item.text.trim() }))
      .filter((item) => item.text.length > 0)
    if (entries.length === 0) return

    const key = scopeKey(scope)
    const written = this.transaction(() => this.write(key, entries))

    if (this.debug) console.error(`[memory] remember ${key}: +${entries.length}`)
    // After the write, never inside it: an embedding is a request, and holding
    // the transaction open across one would lock the other process out.
    await this.embedRows(written)
  }

  async recall(
    scope: MemoryScope,
    query: string,
    opts?: { limit?: number },
  ): Promise<MemoryItem[]> {
    const limit = opts?.limit ?? 5
    const match = toMatchQuery(query)
    const key = scopeKey(scope)

    const items = (await this.rank(key, query, match, limit))
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

  /**
   * What answers the question: the notes whose words match, and then — only if
   * those leave room — the notes meaning reaches.
   *
   * The order is the point, and it was measured. Interleaving the two signals by
   * rank (reciprocal rank fusion, what this used to do) let a near-but-unrelated
   * note displace the one that matched the question's own words: on the eval set
   * that was precision falling from **73.5% to 23.0%** and recall from 97% to
   * 90.9% — the answer lost on questions the words had already answered. A note
   * found by meaning is added *after* the ones found by words, never above them,
   * which is the promise the store makes ("union, not reorder") without the part
   * that cost the answer its place.
   *
   * The words going first is also what makes meaning affordable. The reply is
   * asked of the embedder **only when the words did not fill it**, so a question
   * the index can answer costs no request at all — measured at 0.2 ms against
   * 433 ms for a round trip to a hosted model, paid before every turn otherwise.
   * It is the same rule the two halves of recall already follow: what was said
   * fills what the facts leave.
   *
   * The semantic side is still allowed to introduce a note the words never
   * matched. That is the whole point of it, and the case that made it necessary:
   * a question sharing no word with the note that answers it.
   *
   * There is deliberately no similarity cut-off, and `coverage.ts` does not add
   * one: an absolute floor was added, measured and removed, because the notes a
   * question was about (0.01–0.70) and the notes it was not (0.05–0.31) scored
   * in overlapping bands, so any threshold either loses a correct answer or keeps
   * an unrelated one. What is trimmed there is the *gap* instead.
   *
   * `coverage: false` is this same order with nothing trimmed. It is kept
   * reachable so the two can be measured against each other instead of argued
   * about.
   */
  private async rank(
    key: string,
    text: string,
    match: string | null,
    limit: number,
  ): Promise<Row[]> {
    const lexical = match ? this.select(key, match, limit) : []
    const candidates = lexical.map((row) => ({
      item: row,
      text: row.text,
      byMeaningOnly: false,
    }))

    // Only the embedder is skipped here, never the trim: a question the words
    // already fill is still mostly notes that share a word.
    if (lexical.length < limit) {
      const vector = await this.queryVector(text)
      if (vector) {
        const seen = new Set(lexical.map((row) => row.uid))
        for (const row of this.nearest(key, vector, limit)) {
          if (seen.has(row.uid)) continue
          candidates.push({ item: row, text: row.text, byMeaningOnly: true })
        }
      }
    }

    if (!this.coverage) return candidates.slice(0, limit).map((entry) => entry.item)
    return keepCovered(candidates, text)
      .slice(0, limit)
      .map((entry) => entry.item)
  }

  /** The notes closest to the query, by cosine, best first. */
  private nearest(key: string, query: Float32Array, limit: number): Row[] {
    let rows: VectorRow[]
    try {
      rows = this.vectorStmt.all(key) as unknown as VectorRow[]
    } catch {
      return []
    }
    return rows
      .filter((row) => row.vector && row.vector.byteLength === query.length * 4)
      .map((row) => ({ row, score: dot(query, toVector(row.vector!)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.row)
  }

  /** The question's own vector, or null with no embedder or no answer from it. */
  private async queryVector(query: string): Promise<Float32Array | null> {
    const embedder = this.embedder
    if (!embedder) return null
    try {
      return (await embedder.embed([truncate(query)]))[0] ?? null
    } catch (error) {
      this.warnOnce(`could not embed a question: ${errorMessage(error)}`)
      return null
    }
  }

  /** Attaches vectors to rows the write has already put in the store. */
  private async embedRows(rows: { uid: string; text: string }[]): Promise<boolean> {
    const embedder = this.embedder
    if (!embedder || rows.length === 0) return true
    try {
      const vectors = await embedder.embed(rows.map((row) => truncate(row.text)))
      this.transaction(() => {
        rows.forEach((row, index) => {
          const vector = vectors[index]
          // A vector with nothing in it is left off entirely: stored, it would
          // put the note in every ranking with a score of zero.
          if (vector && !isNoise(vector)) this.setVectorStmt.run(toBlob(vector), row.uid)
        })
      })
      return true
    } catch (error) {
      // The note is written and findable by its words; only its semantic side is
      // missing, and the next process tries again.
      this.warnOnce(`could not embed ${rows.length} note(s): ${errorMessage(error)}`)
      // Only a text the provider itself refuses is written off. A connection that
      // was not up yet, a key that is wrong or a rate limit all may pass next
      // time, and losing a note to one of those is worse than waiting.
      if (!(error instanceof InputRefusedError)) return false
      // A model that refuses one text refuses the whole request, so the batch is
      // tried again one note at a time: what it will not take is marked and left
      // behind rather than blocking the rest of the store on every run.
      if (rows.length === 1) {
        this.markUnusable(rows[0]!.uid)
        return true
      }
      for (const row of rows) await this.embedRows([row])
      return true
    }
  }

  /**
   * Says a note was tried and cannot be embedded. A zero-length vector reads as
   * "no vector" everywhere — the similarity query filters by width — so the
   * fill-in stops offering this note and moves on to the rest of the store.
   */
  private markUnusable(uid: string): void {
    this.setVectorStmt.run(new Uint8Array(0), uid)
  }

  /**
   * Brings the store up to the embedder's model, once per process.
   *
   * A different model means every stored vector is in a space that cannot be
   * compared with the new one, so they are cleared and rewritten rather than
   * quietly measured against the wrong thing.
   */
  private ensureVectors(): Promise<void> {
    const embedder = this.embedder
    if (!embedder) return Promise.resolve()

    this.filling ??= (async () => {
      const stored = this.db.prepare('select value from meta where key = ?').get(EMBEDDED_KEY) as
        | { value?: string }
        | undefined
      if (stored?.value !== embedder.model) {
        this.transaction(() => {
          this.db.exec('update memories set vector = null')
          this.db
            .prepare('insert or replace into meta (key, value) values (?, ?)')
            .run(EMBEDDED_KEY, embedder.model)
        })
        if (this.debug) {
          console.error(`[memory] vectors were of ${stored?.value ?? 'no model'}; re-embedding`)
        }
      }

      const missing = this.db.prepare(
        'select uid, text from memories where vector is null order by created_at desc limit ?',
      )
      // The engine is started in the background on purpose, so the first batch can
      // land before it is listening. A batch that fails is tried again rather than
      // giving up: giving up here would leave every note written so far without a
      // vector until the next process, which is the whole store on the first run.
      let failures = 0
      while (failures < 3) {
        const rows = missing.all(EMBED_BATCH) as unknown as { uid: string; text: string }[]
        if (rows.length === 0) break
        if (await this.embedRows(rows)) {
          failures = 0
          continue
        }
        failures += 1
        await delay(1_000 * failures)
      }
    })().catch((error: unknown) => {
      logWarn(`could not fill in the embeddings: ${errorMessage(error)}`)
    })

    return this.filling
  }

  /** Waits for the fill-in. For tests and shutdown; no turn ever waits on it. */
  async whenEmbedded(): Promise<void> {
    await this.ensureVectors()
  }

  private warnOnce(message: string): void {
    if (this.warned) return
    this.warned = true
    logWarn(`${message} — recall keeps working on words alone`)
  }

  /**
   * Adds the vector column to a store made before there were embeddings. Beside
   * the schema rather than in it, so an older file is brought forward instead of
   * being refused.
   */
  private addVectorColumn(): void {
    const columns = this.db
      .prepare("select name from pragma_table_info('memories')")
      .all() as unknown as { name: string }[]
    if (columns.some((column) => column.name === 'vector')) return
    this.db.exec('alter table memories add column vector blob')
  }

  /**
   * Drops the raw turns a store written before this one kept.
   *
   * They were a copy of what the person typed, held in here so recall could read
   * their words and not only the facts the model chose to save. Recall reads the
   * history log now — every turn this install ever took, no cap — so the copy is
   * dead weight, and dropping it is what keeps this file small. Nothing is lost
   * that was not a copy: the log is where those sentences came from.
   */
  private dropTurns(): void {
    const columns = this.db.prepare("select name from pragma_table_info('memories')").all() as
      | { name: string }[]
    if (!columns.some((column) => column.name === 'kind')) return

    this.transaction(() => {
      this.db.exec("delete from memories where kind = 'said'")
      // The column is indexed; SQLite refuses to drop one that is.
      this.db.exec('drop index if exists memories_scope_kind')
      this.db.exec('alter table memories drop column kind')
    })
    if (this.debug) console.error('[memory] dropped the copied turns; recall reads the history now')
  }

  async list(scope: MemoryScope, opts?: { limit?: number }): Promise<MemoryItem[]> {
    try {
      const rows = this.listStmt.all(
        scopeKey(scope),
        opts?.limit ?? DEFAULT_LIST_LIMIT,
      ) as unknown as Row[]
      return rows.map((row) => ({
        id: row.uid,
        text: row.text,
        createdAt: row.createdAt,
        tags: parseTags(row.tags),
      }))
    } catch {
      // Same rule as recall: a store that cannot be read answers nothing rather
      // than taking down the screen that asked.
      return []
    }
  }

  /**
   * Drops one note. The id may be only the front of one — a whole uuid is a lot
   * to type into a chat — and is accepted only while it names exactly one note,
   * which is what the two-row limit below is for.
   */
  async forget(scope: MemoryScope, id: string): Promise<boolean> {
    const key = scopeKey(scope)
    const wanted = id.trim()
    // The id goes into a LIKE, so it has to be an id and nothing else.
    if (!/^[0-9a-f-]{4,36}$/i.test(wanted)) return false

    const matches = this.db
      .prepare('select uid from memories where scope = ? and uid like ? limit 2')
      .all(key, `${wanted}%`) as unknown as { uid: string }[]
    if (matches.length !== 1) return false

    const removed = Number(this.forgetStmt.run(matches[0]!.uid, key).changes) > 0
    if (this.debug && removed) console.error(`[memory] forgot ${matches[0]!.uid}`)
    return removed
  }

  /** For tests and shutdown: nothing else needs the handle. */
  close(): void {
    this.db.close()
  }

  private select(scope: string, match: string, limit: number): Row[] {
    try {
      return this.selectStmt.all(match, scope, limit) as unknown as Row[]
    } catch {
      // Recall is on the path of every turn, so it is allowed to answer nothing
      // and is never allowed to take the turn down: a store that cannot be read
      // — locked by the other process, or damaged — costs one reply's context.
      return []
    }
  }

  private write(
    scope: string,
    items: (MemoryInput & { createdAt?: number })[],
  ): { uid: string; text: string }[] {
    const written: { uid: string; text: string }[] = []
    for (const item of items) {
      // A durable fact said again in other words is one fact, not two.
      const kept = this.sameFact(scope, item.text)
      if (kept) {
        // Reinforced: it is the same fact, so recency follows the new telling
        // and the row that stays is the one already held.
        this.touchStmt.run(item.createdAt ?? Date.now(), kept, scope)
        continue
      }
      const uid = randomUUID()
      this.insertStmt.run(
        uid,
        scope,
        item.text,
        JSON.stringify(item.tags ?? []),
        item.createdAt ?? Date.now(),
        hashOf(item.text),
      )
      written.push({ uid, text: item.text })
    }
    return written
  }

  /**
   * The fact already kept that is the same words as this one, if any.
   *
   * Two notes are the same note when they are built from the same words —
   * punctuation, word order and filler aside — and only then. A "mostly the
   * same" score was tried and dropped: it cannot tell a rewording from a
   * correction, and one word is what separates "… na segunda" from
   * "… na terça", or a plain fact from the same fact negated. Nor is this
   * semantic: it cannot tell that "meu editor" and "o que uso para codar" are
   * about the same thing.
   */
  private sameFact(scope: string, text: string): string | null {
    const wanted = contentWords(text)
    if (wanted.size === 0) return null

    const rows = this.factTextStmt.all(scope) as unknown as { uid: string; text: string }[]
    for (const row of rows) {
      const kept = contentWords(row.text)
      if (kept.size !== wanted.size) continue
      let same = true
      for (const word of wanted) {
        if (!kept.has(word)) {
          same = false
          break
        }
      }
      if (same) return row.uid
    }
    return null
  }

  /**
   * Brings across what the old JSON store left on disk, once per store. Guarded
   * by a row in `meta`, and non-destructive: the JSON files stay where they are,
   * so nothing is lost by the import.
   */
  private migrate(): void {
    this.dropTurns()
    const done = this.db.prepare('select value from meta where key = ?').get(MIGRATED_KEY)
    if (done) return

    const legacy = readLegacyMemory(path.dirname(this.location))

    this.transaction(() => {
      this.write(scopeKey(INSTALL_SCOPE), legacy)
      this.db
        .prepare('insert or replace into meta (key, value) values (?, ?)')
        .run(MIGRATED_KEY, new Date().toISOString())
    })

    if (this.debug && legacy.length > 0) {
      console.error(
        `[memory] migrated ${legacy.length} note(s) from the JSON store; the files are left in place`,
      )
    }
  }

  /**
   * Moves what was filed per conversation into the one scope an install uses,
   * once per store.
   *
   * Memory used to be filed per chat, so a store older than that has its notes
   * under `cli:main`, `telegram:<id>` and so on — and recall reads one scope now,
   * so without this they would never be found again. A store with nothing to
   * move still settles.
   */
  private unify(): void {
    const done = this.db.prepare('select value from meta where key = ?').get(UNIFIED_KEY)
    if (done) return

    const key = scopeKey(INSTALL_SCOPE)
    const moved = this.transaction(() => {
      // A row is unique per note inside a scope, so two conversations that carry
      // the same sentence collide the moment they share one — and the collapse
      // would fail on the unique index rather than lose a note. One row survives
      // each note: the install scope's if it has one already, then the oldest.
      this.db
        .prepare(
          `delete from memories
            where scope <> ?
              and id in (
                select id from (
                  select id,
                         row_number() over (
                           partition by hash
                           order by (scope = ?) desc, id asc
                         ) as rank
                     from memories
                )
                where rank > 1
              )`,
        )
        .run(key, key)

      const changes = Number(
        this.db.prepare('update memories set scope = ? where scope <> ?').run(key, key).changes,
      )
      this.db
        .prepare('insert or replace into meta (key, value) values (?, ?)')
        .run(UNIFIED_KEY, new Date().toISOString())
      return changes
    })

    if (this.debug && moved > 0) {
      console.error(`[memory] moved ${moved} item(s) into the install scope`)
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
    bytes: 0,
  }
  if (!existsSync(location)) return empty

  let db: DatabaseSync | undefined
  try {
    db = new (loadSqlite().DatabaseSync)(location)
    const counts = db
      .prepare(
        `select count(distinct scope) as scopes,
                count(*) as facts
           from memories`,
      )
      .get() as { scopes: number; facts: number | null }
    return {
      ...empty,
      scopes: Number(counts.scopes ?? 0),
      facts: Number(counts.facts ?? 0),
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

/** Stored vectors are unit length, so closeness is the plain dot product. */
function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!
  return sum
}

function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

function toVector(blob: Uint8Array): Float32Array {
  // Copied, not a view: those bytes belong to the driver's own buffer.
  return new Float32Array(new Uint8Array(blob).buffer)
}

/** The head of a note: what fits, and what a question refers to anyway. */
const truncate = (text: string): string =>
  text.length > EMBED_CHARS ? text.slice(0, EMBED_CHARS) : text

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}
