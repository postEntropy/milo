import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RECALL_SQL,
  SqliteMemory,
  sqliteMemoryFile,
  sqliteMemoryStatus,
} from '../src/core/memory/sqlite.js'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-sql-'))

function open(dir = tempDir(), keepSaid?: number) {
  return { dir, memory: new SqliteMemory({ dir, ...(keepSaid ? { keepSaid } : {}) }) }
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

  it('treats a missing layer as a durable fact', async () => {
    const { memory, dir } = open()
    await memory.remember({ gateway: 'cli', conversationId: 'kind' }, [{ text: 'sem camada' }])

    expect(sqliteMemoryStatus(sqliteMemoryFile(dir)).facts).toBe(1)
  })

  it('never lets a raw turn demote a saved fact', async () => {
    const { memory, dir } = open()
    const scope = { gateway: 'cli', conversationId: 'sticky' }

    await memory.remember(scope, [{ text: 'prefere bullet points', kind: 'fact' }])
    // The person typing the fact back out is the same words, not a new layer.
    await memory.remember(scope, [{ text: 'prefere bullet points', kind: 'said' }])

    const status = sqliteMemoryStatus(sqliteMemoryFile(dir))
    expect(status.facts).toBe(1)
    expect(status.said).toBe(0)
  })

  it('never evicts a fact to make room for chatter', async () => {
    const keepSaid = 5
    const { memory, dir } = open(tempDir(), keepSaid)
    const scope = { gateway: 'cli', conversationId: 'cap' }

    await memory.remember(scope, [{ text: 'the release tag is always v0.1.0', kind: 'fact' }])
    await memory.remember(
      scope,
      Array.from({ length: 50 }, (_, i) => ({ text: `small talk number ${i}`, kind: 'said' as const })),
    )

    // This is the measured defect, as a test: an undifferentiated list with one
    // cap dropped the oldest 100 of 600 items, fact or not.
    const status = sqliteMemoryStatus(sqliteMemoryFile(dir))
    expect(status.facts).toBe(1)
    expect(status.said).toBe(keepSaid)

    const hits = await memory.recall(scope, 'what is the release tag?', { limit: 5 })
    expect(hits.some((hit) => hit.text.includes('release tag'))).toBe(true)
  })

  it('reads a fact before a raw turn that matches just as well', async () => {
    const { memory } = open()
    const scope = { gateway: 'cli', conversationId: 'rank' }

    await memory.remember(scope, [{ text: 'o deploy usa turbo mode hoje', kind: 'said' }])
    await memory.remember(scope, [{ text: 'o deploy usa turbo mode sempre', kind: 'fact' }])

    const hits = await memory.recall(scope, 'deploy turbo', { limit: 2 })
    expect(hits[0]!.text).toBe('o deploy usa turbo mode sempre')
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
    const scope = { gateway: 'cli', conversationId: 'status' }
    await memory.remember(scope, [{ text: 'um fato', kind: 'fact' }])
    await memory.remember(scope, [{ text: 'um turno', kind: 'said' }])
    await memory.remember({ gateway: 'telegram', conversationId: '9' }, [{ text: 'outro' }])

    const status = sqliteMemoryStatus(sqliteMemoryFile(dir))
    expect(status.backend).toBe('sqlite')
    expect(status.scopes).toBe(2)
    expect(status.facts).toBe(2)
    expect(status.said).toBe(1)
    expect(status.bytes).toBeGreaterThan(0)
  })

  it('reports an empty store rather than throwing on a path with no database', () => {
    const status = sqliteMemoryStatus(path.join(tempDir(), 'memory.db'))
    expect(status).toMatchObject({ scopes: 0, facts: 0, said: 0, bytes: 0 })
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
        kind: (i % 50 === 0 ? 'fact' : 'said') as 'fact' | 'said',
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
      .all('deploy', 'cli:plan', 'said', 5)
      .map((row) => row.detail)

    expect(plan[0]).toContain('memories_fts')
    expect(plan.join(' | ')).not.toContain('memories_scope_kind')
  })
})
