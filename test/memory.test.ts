import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileMemory } from '../src/core/memory/local'

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
})
