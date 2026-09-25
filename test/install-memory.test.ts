import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { INSTALL_SCOPE, installMemory } from '../src/core/memory/index.js'
import { SqliteMemory, sqliteMemoryFile, sqliteMemoryStatus } from '../src/core/memory/sqlite.js'
import type { MemoryItem, MemoryScope, TurnSource } from '../src/core/memory/types.js'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-install-'))

/** What a question is asked from, and which questions reached the history. */
function history(items: MemoryItem[]): TurnSource & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async recall(_scope: MemoryScope, query: string) {
      asked.push(query)
      return items
    },
  }
}

const note = (text: string): MemoryItem => ({ id: text, text, createdAt: 1 })

describe('installMemory', () => {
  it('files every conversation in the same memory', async () => {
    const memory = installMemory(new SqliteMemory({ dir: tempDir() }))

    await memory.remember({ gateway: 'cli', conversationId: 'main' }, [
      { text: 'a tag de release e v0.1.0' },
    ])

    // A different surface and a different conversation: the same memory.
    const hits = await memory.recall(
      { gateway: 'telegram', conversationId: '8924510981' },
      'qual a tag de release?',
    )
    expect(hits.some((hit) => hit.text.includes('release'))).toBe(true)
  })

  it('answers from the facts first and fills the rest with what was said', async () => {
    const turns = history([note('meu editor e o neovim'), note('uso tmux tambem')])
    const memory = installMemory(new SqliteMemory({ dir: tempDir() }), turns)
    await memory.remember({ gateway: 'cli', conversationId: 'main' }, [
      { text: 'prefere bullet points' },
    ])

    const hits = await memory.recall({ gateway: 'cli', conversationId: 'main' }, 'bullet tmux', {
      limit: 3,
    })

    expect(hits.map((hit) => hit.text)).toEqual([
      'prefere bullet points',
      'meu editor e o neovim',
      'uso tmux tambem',
    ])
    // The scores are the reply's own order: `1` is still the best note in it.
    expect(hits.map((hit) => hit.score)).toEqual([1, 0.5, 1 / 3])
    expect(turns.asked).toEqual(['bullet tmux'])
  })

  it('does not ask the history when the facts already fill the reply', async () => {
    const turns = history([note('nao deveria aparecer')])
    const memory = installMemory(new SqliteMemory({ dir: tempDir() }), turns)
    await memory.remember({ gateway: 'cli', conversationId: 'main' }, [
      { text: 'prefere bullet points' },
    ])

    const hits = await memory.recall({ gateway: 'cli', conversationId: 'main' }, 'bullet', {
      limit: 1,
    })
    expect(hits.map((hit) => hit.text)).toEqual(['prefere bullet points'])
    // Nothing was asked of it: a store of durable notes is the whole answer.
    expect(turns.asked).toEqual([])
  })

  it('never shows the same sentence twice', async () => {
    // A fact and the turn it was extracted from: the same words, so one line.
    const turns = history([note('prefere bullet points'), note('a senha gira na segunda')])
    const memory = installMemory(new SqliteMemory({ dir: tempDir() }), turns)
    await memory.remember({ gateway: 'cli', conversationId: 'main' }, [
      { text: 'Prefere bullet points' },
    ])

    const hits = await memory.recall({ gateway: 'cli', conversationId: 'main' }, 'bullet senha', {
      limit: 5,
    })
    expect(hits.map((hit) => hit.text)).toEqual([
      'Prefere bullet points',
      'a senha gira na segunda',
    ])
  })

  it('answers from the facts alone when the install has no history index', async () => {
    const memory = installMemory(new SqliteMemory({ dir: tempDir() }))
    await memory.remember({ gateway: 'cli', conversationId: 'main' }, [{ text: 'um fato so' }])

    const hits = await memory.recall({ gateway: 'cli', conversationId: 'main' }, 'fato', {
      limit: 5,
    })
    expect(hits.map((hit) => hit.text)).toEqual(['um fato so'])
  })
})

describe('a store older than the one scope', () => {
  /**
   * Memory used to be filed per conversation. Clearing the marker the unify step
   * leaves is what "a store from before that change" means.
   */
  async function forgetUnification(dir: string): Promise<void> {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(sqliteMemoryFile(dir))
    db.prepare('delete from meta where key = ?').run('unified_scope_v1')
    db.close()
  }

  it('moves notes filed per conversation into the install scope', async () => {
    const dir = tempDir()
    const before = new SqliteMemory({ dir })
    await before.remember({ gateway: 'cli', conversationId: 'main' }, [
      { text: 'o deploy sai na sexta' },
    ])
    await before.remember({ gateway: 'telegram', conversationId: '42' }, [
      { text: 'a senha gira na segunda' },
    ])
    before.close()
    await forgetUnification(dir)

    const after = new SqliteMemory({ dir })
    const found = await after.recall(INSTALL_SCOPE, 'deploy sexta senha segunda', { limit: 10 })
    expect(found.map((hit) => hit.text).sort()).toEqual([
      'a senha gira na segunda',
      'o deploy sai na sexta',
    ])
    // And nothing is left behind under the conversation it was filed in.
    expect(
      await after.recall({ gateway: 'cli', conversationId: 'main' }, 'deploy', { limit: 5 }),
    ).toEqual([])
    after.close()
  })

  it('keeps one row when the same note was filed in two conversations', async () => {
    const dir = tempDir()
    const before = new SqliteMemory({ dir })
    await before.remember({ gateway: 'cli', conversationId: 'main' }, [
      { text: 'a senha gira na segunda' },
    ])
    await before.remember({ gateway: 'telegram', conversationId: '42' }, [
      { text: 'A senha gira na segunda' },
    ])
    before.close()
    await forgetUnification(dir)

    const after = new SqliteMemory({ dir })
    expect(sqliteMemoryStatus(sqliteMemoryFile(dir)).facts).toBe(1)
    expect(await after.recall(INSTALL_SCOPE, 'senha segunda', { limit: 5 })).toHaveLength(1)
    after.close()
  })

  it('does not duplicate anything when the store is reopened', async () => {
    const dir = tempDir()
    const first = new SqliteMemory({ dir })
    await first.remember({ gateway: 'cli', conversationId: 'main' }, [
      { text: 'o deploy sai na sexta' },
    ])
    first.close()
    await forgetUnification(dir)

    new SqliteMemory({ dir }).close()
    const second = new SqliteMemory({ dir })
    expect(sqliteMemoryStatus(sqliteMemoryFile(dir)).facts).toBe(1)
    expect(await second.recall(INSTALL_SCOPE, 'deploy', { limit: 5 })).toHaveLength(1)
    second.close()
  })
})
