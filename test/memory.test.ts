import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMemory } from '../src/core/memory/local.js'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-mem-'))

describe('FileMemory', () => {
  it('remembers and recalls by keyword overlap', async () => {
    const memory = new FileMemory({ dir: tempDir() })
    const scope = { gateway: 'cli', conversationId: 't1' }

    await memory.remember(scope, [{ text: 'My editor is Neovim and I run tmux', tags: ['user'] }])
    const hits = await memory.recall(scope, 'which editor do I use?', { limit: 3 })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.text).toContain('Neovim')
  })

  it('keeps memories isolated per conversation scope', async () => {
    const memory = new FileMemory({ dir: tempDir() })
    await memory.remember({ gateway: 'cli', conversationId: 'a' }, [{ text: 'secret bananas' }])

    const hits = await memory.recall({ gateway: 'cli', conversationId: 'b' }, 'bananas', {
      limit: 3,
    })
    expect(hits).toEqual([])
  })

  it('returns nothing for an unrelated query', async () => {
    const memory = new FileMemory({ dir: tempDir() })
    const scope = { gateway: 'cli', conversationId: 't2' }
    await memory.remember(scope, [{ text: 'I like turtles' }])
    const hits = await memory.recall(scope, 'kubernetes ingress controller', { limit: 3 })
    expect(hits).toEqual([])
  })

  it('matches on a short technical term', async () => {
    const memory = new FileMemory({ dir: tempDir() })
    const scope = { gateway: 'cli', conversationId: 't3' }
    await memory.remember(scope, [{ text: 'the deploy script ends with rm of the cache dir' }])

    // Two-character words used to be dropped from the index, so the question
    // could never match the note.
    const hits = await memory.recall(scope, 'why does the rm run?', { limit: 3 })
    expect(hits.some((hit) => hit.text.includes('deploy script'))).toBe(true)
  })

  it('does not surface a memory just for being recent', async () => {
    const memory = new FileMemory({ dir: tempDir() })
    const scope = { gateway: 'cli', conversationId: 't4' }
    await memory.remember(scope, [{ text: 'the staging database password rotates on mondays' }])

    expect(await memory.recall(scope, 'zzz qqq', { limit: 3 })).toEqual([])
  })
})
