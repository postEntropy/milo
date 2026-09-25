import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadSqlite } from '../src/core/memory/sql.js'
import {
  RECALL_SQL,
  SqliteMemory,
  sqliteMemoryFile,
  sqliteMemoryStatus,
} from '../src/core/memory/sqlite.js'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-sql-'))

function open(dir = tempDir()) {
  return { dir, memory: new SqliteMemory({ dir }) }
}

describe('SqliteMemory', () => {
  it('remembers and recalls by keyword overlap', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 't1' }

    await memory.remember(scope, [{ text: 'My editor is Neovim and I run tmux' }])
    const hits = await memory.recall(scope, 'which editor do I use?', { limit: 3 })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.text).toContain('Neovim')
  })

  it('keeps memories isolated per conversation scope', async () => {
    const { memory } = open()
    await memory.remember({ gateway: 'cli', conversationId: 'a' }, [{ text: 'secret bananas' }])

    const hits = await memory.recall({ gateway: 'cli', conversationId: 'b' }, 'bananas', {
      limit: 3,
    })
    expect(hits).toEqual([])
  })

  it('returns nothing for an unrelated query', async () => {
    const { memory, dir } = open()
    const scope = { gateway: 'cli', conversationId: 't2' }
    await memory.remember(scope, [{ text: 'I like turtles' }])

    expect(sqliteMemoryStatus(sqliteMemoryFile(dir)).facts).toBe(1)
    expect(await memory.recall(scope, 'kubernetes ingress controller', { limit: 3 })).toEqual([])
  })

  it('matches on a short technical term', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 't3' }
    await memory.remember(scope, [{ text: 'the deploy script ends with rm of the cache dir' }])

    // Two-character words used to be dropped from the index, so the question
    // could never match the note.
    const hits = await memory.recall(scope, 'why does the rm run?', { limit: 3 })
    expect(hits.some((hit) => hit.text.includes('deploy script'))).toBe(true)
  })

  it('does not surface a memory just for being recent', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 't4' }
    await memory.remember(scope, [{ text: 'the staging database password rotates on mondays' }])

    expect(await memory.recall(scope, 'zzz qqq', { limit: 3 })).toEqual([])
  })

  it('answers nothing for a query that is all stopwords', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'stop' }
    await memory.remember(scope, [{ text: 'I like turtles' }])

    expect(await memory.recall(scope, 'the of and', { limit: 3 })).toEqual([])
  })

  it('takes a query full of punctuation without failing the turn', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'syntax' }
    await memory.remember(scope, [{ text: 'the ingress controller sits behind a proxy' }])

    // The tokenizer is what keeps this safe: nothing but words reaches MATCH, so
    // FTS5 syntax cannot be smuggled in and recall never throws on a sentence.
    const hits = await memory.recall(scope, 'ingress - "controller" * (proxy) not:colon', {
      limit: 3,
    })
    expect(hits.some((hit) => hit.text.includes('ingress'))).toBe(true)
  })

  it('matches with or without the accent', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'accent' }
    await memory.remember(scope, [{ text: 'a configuração do proxy está pronta' }])

    // `você` would prove nothing here: it is a stopword, so it never reaches the
    // index as a query. A content word is what the folding actually has to carry.
    expect(await memory.recall(scope, 'configuração', { limit: 3 })).toHaveLength(1)
    expect(await memory.recall(scope, 'configuracao', { limit: 3 })).toHaveLength(1)
  })

  it('keeps one row for the same note saved twice', async () => {
    const { memory, dir } = open()
    const scope = { gateway: 'cli', conversationId: 'dup' }
    await memory.remember(scope, [{ text: 'Renato prefere tabs' }])
    await memory.remember(scope, [{ text: '  renato   prefere TABS ' }])

    expect(sqliteMemoryStatus(sqliteMemoryFile(dir)).facts).toBe(1)
    expect(await memory.recall(scope, 'tabs', { limit: 5 })).toHaveLength(1)
  })

  it('returns no more than the limit asked for', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'limit' }
    await memory.remember(
      scope,
      Array.from({ length: 10 }, (_, i) => ({ text: `common note ${i}` })),
    )

    expect(await memory.recall(scope, 'common', { limit: 2 })).toHaveLength(2)
  })

  it('reports size and counts for the setup screen', async () => {
    const { memory, dir } = open()
    await memory.remember({ gateway: 'cli', conversationId: 'status' }, [{ text: 'um fato' }])
    await memory.remember({ gateway: 'telegram', conversationId: '9' }, [{ text: 'outro' }])

    const status = sqliteMemoryStatus(sqliteMemoryFile(dir))
    expect(status.backend).toBe('sqlite')
    expect(status.scopes).toBe(2)
    expect(status.facts).toBe(2)
    expect(status.bytes).toBeGreaterThan(0)
  })

  it('reports an empty store rather than throwing on a path with no database', () => {
    const status = sqliteMemoryStatus(path.join(tempDir(), 'memory.db'))
    expect(status).toMatchObject({ scopes: 0, facts: 0, bytes: 0 })
  })

  it('drives recall from the FTS index instead of probing it once per row', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'plan' }
    // 500, the size the defect was measured at: with a small corpus the planner
    // happens to pick the good order anyway, so a guard built on 60 rows would
    // hold the regression in place rather than catch it.
    await memory.remember(
      scope,
      Array.from({ length: 500 }, (_, i) => ({
        text: i % 50 === 0 ? `a tag de release e v0.${i}` : `nota ${i} sobre o deploy do servidor`,
      })),
    )

    // White-box on purpose. Both plans return the same rows, so no behavioural
    // test can see the difference — and the wrong one is 53 ms against 0.6 ms,
    // on the path of every turn. Reading the plan is the only way to hold it.
    //
    // It is also version-dependent, which is the point: Node 22's SQLite picks
    // the table-driven plan and Node 26's does not, so this only fails where the
    // defect actually happens — and the CI matrix runs 22. Pinning the join
    // order is what makes the answer the same on both.
    const internals = memory as unknown as {
      db: { prepare: (sql: string) => { all: (...args: unknown[]) => { detail: string }[] } }
    }
    const plan = internals.db
      .prepare(`explain query plan ${RECALL_SQL}`)
      .all('deploy', 'cli:plan', 5)
      .map((row) => row.detail)

    expect(plan[0]).toContain('memories_fts')
    // The bad plan walks the table and probes the index once per row; the pinned
    // `cross join` is what keeps the index in front.
    expect(plan.join(' | ')).not.toMatch(/\bSCAN (m|memories)\b/)
  })

  it('lists what it keeps, newest first', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'list' }
    await memory.remember(scope, [{ text: 'um turno antigo' }])
    await memory.remember(scope, [{ text: 'Renato prefere bullet points' }])

    const notes = await memory.list(scope)
    expect(notes.map((note) => note.text)).toEqual([
      'Renato prefere bullet points',
      'um turno antigo',
    ])
    expect(notes[0]!.id).toBeTruthy()
  })

  it('drops one note by the front of its id, and only then', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'forget' }
    await memory.remember(scope, [
      { text: 'o deploy sai na sexta' },
      { text: 'a senha gira na segunda' },
    ])

    const first = (await memory.list(scope))[0]!
    expect(await memory.forget(scope, first.id.slice(0, 8))).toBe(true)
    expect((await memory.list(scope)).map((note) => note.text)).toEqual(['o deploy sai na sexta'])

    // An id-shaped id that matches nothing, and something that is not an id at
    // all — which must not reach the LIKE it is built into.
    expect(await memory.forget(scope, 'dead')).toBe(false)
    expect(await memory.forget(scope, 'o deploy%')).toBe(false)
  })

  it('keeps one fact when the same words come back reworded', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'same' }
    await memory.remember(scope, [{ text: 'o deploy sai na sexta.' }])
    await memory.remember(scope, [{ text: 'Deploy sai na sexta' }])

    // Punctuation, case and filler differ; the words that carry the fact do not.
    const notes = await memory.list(scope)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.text).toBe('o deploy sai na sexta.')
  })

  it('never folds a fact that differs in a content word', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'correction' }
    await memory.remember(scope, [{ text: 'a senha gira na segunda' }])
    await memory.remember(scope, [{ text: 'a senha gira na terça' }])

    // A correction, not a duplicate: both stay, or the wrong one would be kept.
    expect((await memory.list(scope)).map((note) => note.text).sort()).toEqual([
      'a senha gira na segunda',
      'a senha gira na terça',
    ])
  })

  it('counts short words and numbers, so versão 1 is not versão 2', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'digits' }
    await memory.remember(scope, [
      { text: 'a versao atual e a 1' },
      { text: 'a versao atual e a 2' },
    ])

    // The recall vocabulary drops single characters; identity must not, or these
    // would be the same words and one of them would vanish.
    expect(await memory.list(scope)).toHaveLength(2)
  })

  it('drops the copied turns a store written before this one kept', async () => {
    const dir = tempDir()
    // The shape of the store when it kept a copy of what the person typed: a
    // `kind` column, its index, and rows of both — FTS and triggers included,
    // because that is what a real one had and a delete reaches them.
    const { DatabaseSync } = loadSqlite()
    const old = new DatabaseSync(sqliteMemoryFile(dir))
    old.exec(`
      create table memories (
        id integer primary key,
        uid text not null unique,
        scope text not null,
        text text not null,
        kind text not null check (kind in ('fact','said')),
        tags text not null default '[]',
        created_at integer not null,
        hash text not null,
        vector blob
      );
      create unique index memories_scope_hash on memories(scope, hash);
      create index memories_scope_kind on memories(scope, kind, created_at desc);
      create virtual table memories_fts using fts5(
        text, content='memories', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );
      create trigger memories_ai after insert on memories begin
        insert into memories_fts(rowid, text) values (new.id, new.text);
      end;
      create trigger memories_ad after delete on memories begin
        insert into memories_fts(memories_fts, rowid, text) values ('delete', old.id, old.text);
      end;
      insert into memories (uid, scope, text, kind, tags, created_at, hash)
        values ('u1', 'local:install', 'prefere bullet points', 'fact', '["assistant"]', 1, 'h1'),
               ('u2', 'local:install', 'bom dia', 'said', '["user"]', 2, 'h2');
    `)
    old.close()

    const memory = new SqliteMemory({ dir })
    const notes = await memory.list({ gateway: 'local', conversationId: 'install' })
    expect(notes.map((note) => note.text)).toEqual(['prefere bullet points'])

    // And the column is gone rather than left empty, so nothing can write one.
    const db = new DatabaseSync(sqliteMemoryFile(dir))
    const columns = db.prepare("select name from pragma_table_info('memories')").all() as {
      name: string
    }[]
    db.close()
    expect(columns.map((column) => column.name)).not.toContain('kind')
    memory.close()
  })
})
