import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { INSTALL_SCOPE } from '../src/core/memory/index.js'
import { readLegacyMemory } from '../src/core/memory/migrate.js'
import { sqliteMemoryFile, sqliteMemoryStatus, SqliteMemory } from '../src/core/memory/sqlite.js'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-mig-'))

/** What the old JSON store wrote: the scope with `:` flattened, and a JSON array. */
const legacy = (dir: string, name: string, items: unknown[]) =>
  writeFileSync(path.join(dir, name), JSON.stringify(items, null, 2))

const FACT = { id: 'a', text: 'Renato prefere bullet points', createdAt: 1_000, tags: ['assistant'] }
const LATER = { id: 'c', text: 'a senha gira na segunda', createdAt: 2_000, tags: ['assistant'] }
const SAID = { id: 'b', text: 'oi tudo bem por ai', createdAt: 3_000, tags: ['user'] }

describe('readLegacyMemory', () => {
  it('takes the facts and leaves the turns for the history log', () => {
    const dir = tempDir()
    legacy(dir, 'cli_main.json', [FACT, SAID])

    // The old store wrote what the person typed at the end of every turn, tagged
    // `user`. Those are turns, and turns live in the log now — importing them
    // here would put chatter back in the store of durable facts.
    expect(readLegacyMemory(dir).map((item) => item.text)).toEqual([FACT.text])
  })

  it('keeps the original time, so recency still orders old notes', () => {
    const dir = tempDir()
    legacy(dir, 'cli_main.json', [FACT, LATER])

    expect(readLegacyMemory(dir).map((item) => item.createdAt)).toEqual([1_000, 2_000])
  })

  it('reads every conversation’s file, and skips what is not one', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'cli_main.json'), '[{"id":"a","text":"trunc')
    writeFileSync(path.join(dir, 'notes.txt'), 'not a scope')
    legacy(dir, 'cli_other.json', [FACT])

    expect(readLegacyMemory(dir).map((item) => item.text)).toEqual([FACT.text])
  })

  it('says nothing about a directory that does not exist', () => {
    expect(readLegacyMemory(path.join(tempDir(), 'nope'))).toEqual([])
  })
})

describe('migration into the sqlite store', () => {
  it('brings the JSON across and leaves the files where they are', async () => {
    const dir = tempDir()
    legacy(dir, 'cli_main.json', [FACT, SAID])

    const memory = new SqliteMemory({ dir })
    // Read through the scope the install actually asks with: the notes come back
    // under it regardless of which conversation's file they came from.
    const hits = await memory.recall(INSTALL_SCOPE, 'bullet points')

    expect(hits.some((hit) => hit.text.includes('bullet points'))).toBe(true)
    expect(sqliteMemoryStatus(sqliteMemoryFile(dir))).toMatchObject({ scopes: 1, facts: 1 })
    // Non-destructive: the JSON files are left where they are.
    expect(readdirSync(dir)).toContain('cli_main.json')
    expect(JSON.parse(readFileSync(path.join(dir, 'cli_main.json'), 'utf8'))).toEqual([FACT, SAID])
  })

  it('imports once, not on every open', async () => {
    const dir = tempDir()
    legacy(dir, 'cli_main.json', [FACT])

    new SqliteMemory({ dir }).close()
    const second = new SqliteMemory({ dir })
    const status = sqliteMemoryStatus(sqliteMemoryFile(dir))

    expect(status.facts).toBe(1)
    // And the duplicate is not merely suppressed by the hash: one row, read once.
    expect(await second.recall(INSTALL_SCOPE, 'bullet points')).toHaveLength(1)
  })

  it('records the migration, so a store with nothing to import still settles', () => {
    const dir = tempDir()
    const memory = new SqliteMemory({ dir })

    // A second open with a file added afterwards must not import it: the ledger
    // is the guard, not the presence of rows.
    memory.close()
    legacy(dir, 'cli_late.json', [FACT])
    new SqliteMemory({ dir }).close()

    expect(sqliteMemoryStatus(sqliteMemoryFile(dir)).scopes).toBe(0)
  })
})
