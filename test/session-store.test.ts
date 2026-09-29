import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import lockfile from 'proper-lockfile'
import { FileSessionStore } from '../src/core/sessions/file-store.js'
import { MemorySessionStore } from '../src/core/sessions/memory-store.js'
import { FileRecapStore } from '../src/core/sessions/recap.js'
import { pruneSessions } from '../src/core/sessions/retention.js'
import {
  INITIAL_SESSION_VERSION,
  isValidSessionId,
  SessionConflictError,
  type SessionRecord,
} from '../src/core/sessions/types.js'

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-store-'))

function record(id: string, updatedAt = Date.now()): SessionRecord {
  return {
    id,
    createdAt: updatedAt,
    updatedAt,
    messages: [{ role: 'user', content: [{ type: 'text', text: `hello from ${id}` }] }],
    version: INITIAL_SESSION_VERSION,
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
    await store.save(created, created.version)

    const loaded = await store.load(created.id)
    expect(loaded?.messages).toHaveLength(2)
    expect(loaded?.id).toBe(created.id)

    const list = await store.list()
    expect(list.map((entry) => entry.id)).toEqual([created.id])
    expect(list[0]!.preview).toContain('hello')
  })

  it('counts the conversation, not the tool results behind it', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    const created = await store.create()
    created.messages.push(
      { role: 'user', content: [{ type: 'text', text: 'take a shot and send it' }] },
      // One assistant message carrying both calls, then one result message per
      // call: a turn with two tool calls is one exchange, not four messages.
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'shell_command', args: { command: 'grim' } },
          { type: 'tool-call', id: 'c2', name: 'send_file', args: { path: 'shot.png' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'shell_command', content: 'ok', isError: false }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c2', name: 'send_file', content: 'Sent shot.png', isError: false }] },
      { role: 'assistant', content: [{ type: 'text', text: 'sent' }] },
    )
    await store.save(created, created.version)

    const summary = (await store.list())[0]!
    expect(summary.messageCount).toBe(3)
  })

  it('keeps the ids it hands out unique', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    const ids = new Set<string>()
    for (let i = 0; i < 30; i += 1) ids.add((await store.create()).id)
    expect(ids.size).toBe(30)
  })

  it('lists the most recently updated session first', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    await store.save(record('calm-otter-1', 100), INITIAL_SESSION_VERSION)
    await store.save(record('brave-wolf-2', 200), INITIAL_SESSION_VERSION)

    expect((await store.list()).map((entry) => entry.id)).toEqual(['brave-wolf-2', 'calm-otter-1'])
  })

  it('writes atomically, leaving no temp files behind', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })
    await store.save(record('calm-otter-1'), INITIAL_SESSION_VERSION)
    await store.setBinding('cli:main', 'calm-otter-1')

    const files = readdirSync(dir)
    expect(files.some((file) => file.endsWith('.tmp'))).toBe(false)
    expect(files).toContain('calm-otter-1.json')
    // Each scope owns its own binding file, so two processes never rewrite a
    // shared map.
    expect(readdirSync(path.join(dir, 'bindings'))).toHaveLength(1)
  })

  it('keeps two scopes apart, including ones that sanitize to the same name', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })
    await store.setBinding('telegram:42', 'calm-otter-1')
    await store.setBinding('telegram-42', 'brave-wolf-2')
    await store.setBinding('discord:9', 'calm-otter-3')

    expect(await store.getBinding('telegram:42')).toBe('calm-otter-1')
    expect(await store.getBinding('telegram-42')).toBe('brave-wolf-2')
    expect(await store.getBinding('discord:9')).toBe('calm-otter-3')
    expect(readdirSync(path.join(dir, 'bindings'))).toHaveLength(3)
  })

  it('still reads the single-file layout an older version wrote', async () => {
    const dir = tempDir()
    writeFileSync(
      path.join(dir, 'bindings.json'),
      JSON.stringify({ 'cli:main': 'calm-otter-1', 'bad:id': '../evil' }),
    )
    const store = new FileSessionStore({ dir })

    expect(await store.getBinding('cli:main')).toBe('calm-otter-1')
    expect(await store.getBinding('bad:id')).toBeUndefined()
  })

  it('claims the id on disk when it hands one out', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })
    const created = await store.create()

    // The file exists from the moment the id does, so a second process cannot
    // take the same nickname.
    expect(readdirSync(dir)).toContain(`${created.id}.json`)
    expect(await store.create()).not.toBe(created.id)
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
    await expect(store.save({ ...record('ok'), id: '../evil' }, INITIAL_SESSION_VERSION)).rejects.toThrow(
      /Invalid session id/,
    )
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
    await store.save(created, created.version)
    await store.remove(created.id)
    expect(await store.load(created.id)).toBeNull()
    expect(await store.list()).toEqual([])
  })
})

// Every run leaves a session behind, so the directory has to be pruned.
describe('pruning old sessions', () => {
  const seed = async (store: FileSessionStore | MemorySessionStore) => {
    await store.save(record('calm-otter-1', 100), INITIAL_SESSION_VERSION)
    await store.save(record('brave-wolf-2', 200), INITIAL_SESSION_VERSION)
    await store.save(record('tidy-heron-3', 300), INITIAL_SESSION_VERSION)
  }

  it('keeps the newest and removes the rest', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    await seed(store)

    const removed = await store.prune({ keep: 2 })
    expect(removed).toEqual(['calm-otter-1'])
    expect((await store.list()).map((entry) => entry.id)).toEqual(['tidy-heron-3', 'brave-wolf-2'])
  })

  it('never removes a session a scope is bound to', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    await seed(store)
    await store.setBinding('cli:main', 'calm-otter-1')

    // `keep: 1` puts both the other old ones out — but the bound session is
    // spared, because a binding to a session that is gone would only silently
    // start a new conversation on the next message.
    expect(await store.prune({ keep: 1 })).toEqual(['brave-wolf-2'])
    expect(await store.load('calm-otter-1')).not.toBeNull()
  })

  it('honours an explicit protect list', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    await seed(store)

    expect(await store.prune({ keep: 1, protect: ['calm-otter-1'] })).toEqual(['brave-wolf-2'])
    expect(await store.load('calm-otter-1')).not.toBeNull()
  })

  it('does nothing when there is nothing beyond the limit', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    await store.create()
    expect(await store.prune({ keep: 5 })).toEqual([])
  })

  it('keeps every one when the limit is zero, which is how "no limit" is written', async () => {
    const file = new FileSessionStore({ dir: tempDir() })
    await seed(file)
    expect(await file.prune({ keep: 0 })).toEqual([])
    expect(await file.list()).toHaveLength(3)

    // The same word has to mean the same thing in both stores, since the config
    // hands the number to whichever one is in use.
    const memory = new MemorySessionStore()
    await seed(memory)
    expect(await memory.prune({ keep: 0 })).toEqual([])
    expect(await memory.list()).toHaveLength(3)
  })

  it('prunes the in-memory store the same way', async () => {
    const store = new MemorySessionStore()
    await seed(store)
    await store.setBinding('cli:main', 'calm-otter-1')

    expect(await store.prune({ keep: 2 })).toEqual([])
    expect((await store.list()).map((entry) => entry.id)).toEqual([
      'tidy-heron-3',
      'brave-wolf-2',
      'calm-otter-1',
    ])
  })

  it('takes the recaps of what it removed, and leaves the rest', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })
    const recaps = new FileRecapStore({ dir: path.join(dir, 'recaps') })
    await seed(store)
    await recaps.write({ session: 'calm-otter-1', text: 'x', sourceUpdatedAt: 100, at: 100 })
    await recaps.write({ session: 'tidy-heron-3', text: 'y', sourceUpdatedAt: 300, at: 300 })

    expect(await pruneSessions(store, recaps, 2)).toBe(1)
    expect(await recaps.read('calm-otter-1')).toBeNull()
    expect(await recaps.read('tidy-heron-3')).not.toBeNull()
  })
})

// Two store instances over one directory stand in for two processes.
describe('concurrent writers', () => {
  function message(text: string) {
    return { role: 'user' as const, content: [{ type: 'text' as const, text }] }
  }

  it('refuses a save built from a revision another writer has moved past', async () => {
    const dir = tempDir()
    const first = new FileSessionStore({ dir })
    const second = new FileSessionStore({ dir })
    const created = await first.create()

    // Both processes open the same session and hold their own copy.
    const one = (await first.load(created.id))!
    const two = (await second.load(created.id))!

    one.messages.push(message('from the first'))
    await first.save(one, created.version)

    two.messages.push(message('from the second'))
    await expect(second.save(two, created.version)).rejects.toBeInstanceOf(SessionConflictError)

    // The stale copy did not erase the turn that landed in between.
    const onDisk = (await first.load(created.id))!
    expect(onDisk.messages).toEqual([message('from the first')])
    expect(onDisk.version).toBe(created.version + 1)
  })

  it('accepts the stale writer once it rereads the record', async () => {
    const dir = tempDir()
    const first = new FileSessionStore({ dir })
    const second = new FileSessionStore({ dir })
    const created = await first.create()

    const one = (await first.load(created.id))!
    one.messages.push(message('from the first'))
    await first.save(one, created.version)

    // Retrying against the revision actually on disk is the whole recovery path.
    const two = (await second.load(created.id))!
    two.messages.push(message('from the second'))
    await second.save(two, two.version)

    expect((await first.load(created.id))!.messages).toEqual([
      message('from the first'),
      message('from the second'),
    ])
  })

  it('waits for a lock another process is holding', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })
    const created = await store.create()
    const file = path.join(dir, `${created.id}.json`)

    // A foreign lock, as another process mid-save would hold it.
    const release = await lockfile.lock(file, { realpath: false, stale: 10_000 })
    let saved = false
    const saving = store.save({ ...created, messages: [message('later')] }, created.version).then(() => {
      saved = true
    })

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(saved).toBe(false)

    await release()
    await saving
    expect(saved).toBe(true)
  })

  it('does not let a stale save resurrect a session another writer removed', async () => {
    const dir = tempDir()
    const first = new FileSessionStore({ dir })
    const second = new FileSessionStore({ dir })
    const created = await first.create()
    await first.save({ ...created, messages: [message('one')] }, created.version)

    const stale = (await second.load(created.id))!
    await first.remove(created.id)

    // The revision is gone with the file, so the save built from it is refused
    // rather than quietly bringing the session back.
    await expect(second.save(stale, stale.version)).rejects.toBeInstanceOf(SessionConflictError)
    expect(await second.load(created.id)).toBeNull()
  })

  it('leaves no lock directory behind', async () => {
    const dir = tempDir()
    const store = new FileSessionStore({ dir })
    const created = await store.create()
    const lease = (await store.tryAcquire(created.id))!
    await store.save(created, created.version)
    await lease.release()

    expect(readdirSync(dir).some((entry) => entry.includes('.lock'))).toBe(false)
  })

  it('reads a record written before revisions and saves it', async () => {
    const dir = tempDir()
    writeFileSync(
      path.join(dir, 'calm-otter-1.json'),
      JSON.stringify({
        id: 'calm-otter-1',
        createdAt: 1,
        updatedAt: 1,
        messages: [message('from before')],
      }),
    )
    const store = new FileSessionStore({ dir })

    const loaded = (await store.load('calm-otter-1'))!
    expect(loaded.version).toBe(INITIAL_SESSION_VERSION)

    loaded.messages.push(message('since'))
    await store.save(loaded, loaded.version)
    expect((await store.load('calm-otter-1'))!.version).toBe(INITIAL_SESSION_VERSION + 1)
  })
})

// The lease serializes whole turns. Two store instances over one directory
// stand in for two processes reaching the same session.
describe('session leases', () => {
  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

  it('hands a session to one holder at a time, and frees it on release', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    const created = await store.create()

    const lease = (await store.tryAcquire(created.id))!
    expect(lease.latest?.id).toBe(created.id)
    expect(await store.tryAcquire(created.id)).toBeNull()

    await lease.release()
    const next = await store.tryAcquire(created.id)
    expect(next).not.toBeNull()
    await next!.release()
  })

  it('holds the session against another store over the same directory', async () => {
    const dir = tempDir()
    const first = new FileSessionStore({ dir })
    const second = new FileSessionStore({ dir })
    const created = await first.create()

    const lease = (await first.tryAcquire(created.id))!
    // A second process is a second store, so nothing in-process is holding it.
    expect(await second.tryAcquire(created.id)).toBeNull()

    await lease.release()
    const next = await second.tryAcquire(created.id)
    expect(next).not.toBeNull()
    await next!.release()
  })

  it('gives the session to a waiter once the holder releases it', async () => {
    const dir = tempDir()
    const first = new FileSessionStore({ dir })
    const second = new FileSessionStore({ dir })
    const created = await first.create()
    const lease = (await first.tryAcquire(created.id))!

    let taken = false
    const waiting = second.acquire(created.id).then(async (next) => {
      taken = true
      await next.release()
    })
    await settle()
    expect(taken).toBe(false)

    await lease.release()
    await waiting
    expect(taken).toBe(true)
  })

  it('gives up the wait when the turn is stopped, without keeping the lock', async () => {
    const dir = tempDir()
    const first = new FileSessionStore({ dir })
    const second = new FileSessionStore({ dir })
    const created = await first.create()
    const lease = (await first.tryAcquire(created.id))!

    const controller = new AbortController()
    const waiting = second.acquire(created.id, { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toThrow(/aborted/)

    await lease.release()
    await settle()
    // The abandoned wait let the lock go: the session is free again.
    const next = await second.tryAcquire(created.id)
    expect(next).not.toBeNull()
    await next!.release()
  })

  it('holds a session in memory too, where there is no file to lock', async () => {
    const store = new MemorySessionStore()
    const created = await store.create()

    const lease = (await store.tryAcquire(created.id))!
    expect(await store.tryAcquire(created.id)).toBeNull()
    await lease.release()
    expect(await store.tryAcquire(created.id)).not.toBeNull()
  })

  it('waits for a turn to end rather than deleting the record out from under it', async () => {
    const store = new FileSessionStore({ dir: tempDir() })
    const created = await store.create()
    const lease = (await store.tryAcquire(created.id))!

    let removed = false
    const removal = store.remove(created.id).then(() => {
      removed = true
    })
    await settle()
    expect(removed).toBe(false)

    await lease.release()
    await removal
    expect(await store.load(created.id)).toBeNull()
  })

  // The guarantee is about two processes, so this one runs two of them. The
  // tests above hold two store instances instead, which is the same lock only
  // because the lock is on the filesystem rather than in the process.
  it(
    'serializes two real processes on one session',
    async () => {
      const dir = tempDir()
      const store = new FileSessionStore({ dir })
      const created = await store.create()
      const child = fileURLToPath(new URL('./fixtures/lease-child.ts', import.meta.url))

      const run = (label: string) =>
        new Promise<void>((resolve, reject) => {
          const proc = spawn(process.execPath, ['--import', 'tsx', child, dir, created.id, label], {
            stdio: ['ignore', 'ignore', 'pipe'],
          })
          let stderr = ''
          proc.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
          })
          proc.on('error', reject)
          proc.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${stderr}`)),
          )
        })

      await Promise.all([run('A'), run('B')])

      // Both turns are there — nobody's write was lost — and the revision moved
      // exactly twice, which is what says the two saves were serialized instead
      // of one being refused as stale.
      const final = (await store.load(created.id))!
      const texts = final.messages.map((message) => (message.content[0] as { text: string }).text)
      expect([...texts].sort()).toEqual(['A', 'B'])
      expect(final.version).toBe(created.version + 2)
    },
    60_000,
  )
})
