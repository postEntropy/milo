import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSessionStore } from '../src/core/sessions/file-store'
import { isValidSessionId, type SessionRecord } from '../src/core/sessions/types'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-store-'))

function record(id: string, updatedAt = Date.now()): SessionRecord {
  return {
    id,
    createdAt: updatedAt,
    updatedAt,
    messages: [{ role: 'user', content: [{ type: 'text', text: `hello from ${id}` }] }],
  }
}

describe('FileSessionStore', () => {
  it('saves, loads and lists sessions', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })

    const created = await store.create()
    expect(isValidSessionId(created.id)).toBe(true)

    created.messages.push({ role: 'user', content: [{ type: 'text', text: 'hello there' }] })
    created.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] })
    await store.save(created)

    const loaded = await store.load(created.id)
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.id).toBe(created.id)

    const list = await store.list()
    expect(list.map((entry) => entry.id)).toEqual([created.id])
    expect(list[0]!.preview).toContain('hello')
  })

  it('keeps the ids it hands out unique', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    const ids = new Set<string>()
    for (let i = 0; i < 30; i += 1) ids.add((await store.create()).id)
    expect(ids.size).toBe(30)
  })

  it('lists the most recently updated session first', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    await store.save(record('calm-otter-1', 100))
    await store.save(record('brave-wolf-2', 200))

    expect((await store.list()).map((entry) => entry.id)).toEqual(['brave-wolf-2', 'calm-otter-1'])
  })

  it('writes atomically, leaving no temp files behind', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })
    await store.save(record('calm-otter-1'))
    await store.setBinding('cli:main', 'calm-otter-1')

    const files = readdirSync(dir)
    expect(files.some((file) => file.endsWith('.tmp'))).toBe(false)
    expect(files).toContain('calm-otter-1.json')
    expect(files).toContain('bindings.json')
  })

  it('persists bindings across store instances', async () => {
    const dir = tempDir()
    await new FileSessionStore({ dir }).setBinding('telegram:42', 'calm-otter-1')
    expect(await new FileSessionStore({ dir }).getBinding('telegram:42')).toBe('calm-otter-1')
  })

  it('refuses ids that would escape the sessions directory', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })

    expect(await store.load('../../etc/passwd')).toBeNull()
    expect(await store.load('..%2fetc')).toBeNull()
    await expect(store.save({ ...record('ok'), id: '../evil' })).rejects.toThrow(/Invalid session id/)
    expect(await store.remove('../../etc/passwd')).toBeUndefined()
  })

  it('drops a binding whose id is malformed', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })
    await store.setBinding('cli:main', '../evil')
    expect(await store.getBinding('cli:main')).toBeUndefined()
  })

  it('forgets a session on remove', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    const created = await store.create()
    await store.save(created)
    await store.remove(created.id)
    expect(await store.load(created.id)).toBeNull()
    expect(await store.list()).toEqual([])
  })
})
