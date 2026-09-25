import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLegacyMemory } from '../src/core/memory/migrate.js'
import { sqliteMemoryFile, sqliteMemoryStatus, SqliteMemory } from '../src/core/memory/sqlite.js'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-mig-'))

/** What `FileMemory` wrote: the scope with `:` flattened, and a JSON array. */
const legacy = (dir: string, name: string, items: unknown[]) =>
  writeFileSync(path.join(dir, name), JSON.stringify(items, null, 2))

const FACT = { id: 'a', text: 'Renato prefere bullet points', createdAt: 1_000, tags: ['assistant'] }
const SAID = { id: 'b', text: 'oi tudo bem por ai', createdAt: 2_000, tags: ['user'] }

describe('readLegacyMemory', () => {
  it('puts the scope separator back and keeps the two layers apart', () => {
    const dir = tempDir()
    legacy(dir, 'cli_main.json', [FACT, SAID])

    const [entry] = readLegacyMemory(dir)
    expect(entry?.scope).toBe('cli:main')
    expect(entry?.items.map((item) => item.kind)).toEqual(['fact', 'said'])
  })

  it('keeps the original time, so recency still orders old notes', () => {
    const dir = tempDir()
    legacy(dir, 'cli_main.json', [FACT, SAID])

    expect(readLegacyMemory(dir)[0]?.items.map((item) => item.createdAt)).toEqual([1_000, 2_000])
  })

  it('skips a half-written file and the files that are not scopes', () => {
    const dir = tempDir()
    writeFileSync(path.join(dir, 'cli_main.json'), '[{"id":"a","text":"trunc')
    writeFileSync(path.join(dir, 'notes.txt'), 'not a scope')
    legacy(dir, 'cli_other.json', [FACT])

    expect(readLegacyMemory(dir).map((entry) => entry.scope)).toEqual(['cli:other'])
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
    // Read through the real scope key: the file name was lossy, the point of
    // the migration is that the notes come back under the key recall asks with.
    const hits = await memory.recall({ gateway: 'cli', conversationId: 'main' }, 'bullet points')

    expect(hits.some((hit) => hit.text.includes('bullet points'))).toBe(true)
    expect(sqliteMemoryStatus(sqliteMemoryFile(dir))).toMatchObject({ scopes: 1, facts: 1, said: 1 })
    // Non-destructive, so going back to `backend: "file"` still works.
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
    expect(await second.recall({ gateway: 'cli', conversationId: 'main' }, 'bullet points')).toHaveLength(
      1,
    )
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
