import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'

const previousHome = process.env.MILO_HOME
const home = mkdtempSync(path.join(tmpdir(), 'milo-folder-'))
process.env.MILO_HOME = home
const { AgentRuntime } = await import('../src/core/runtime.js')
const { FileSessionStore } = await import('../src/core/sessions/file-store.js')
const { MemorySessionSeen } = await import('../src/core/sessions/seen.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')
const { placeProject, readProjects } = await import('../src/core/projects.js')
const { readProjectInstructions } = await import('../src/core/agent/instructions.js')
const { buildCommandContext, handleCommand } = await import('../src/gateways/commands.js')

class ProviderStub implements Provider {
  readonly id = 'stub'
  system = ''
  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    this.system = request.system ?? ''
    yield { type: 'text', delta: 'ok' }
    yield { type: 'done', finishReason: 'stop' }
  }
}
function build(dir: string) {
  const provider = new ProviderStub()
  const store = new FileSessionStore({ dir })
  const runtime = new AgentRuntime({
    provider, model: 'm', system: 'BASE', cwd: home, store,
    registry: createToolRegistry(), seen: new MemorySessionSeen(), project: placeProject,
    instructions: readProjectInstructions,
    memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
  })
  return { runtime, store, provider }
}
async function drain(events: AsyncGenerator<unknown>) { for await (const _event of events) { /* consume */ } }
const scope = { gateway: 'web', chatId: 'folder-test' }
afterAll(() => {
  if (previousHome === undefined) delete process.env.MILO_HOME
  else process.env.MILO_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('a Session folder', () => {
  it('preserves the Session and transcript while another runtime adopts the new folder and rules', async () => {
    const dir = path.join(home, 'sessions-one')
    const folder = path.join(home, 'chosen')
    mkdirSync(folder)
    writeFileSync(path.join(folder, 'AGENTS.md'), 'FOLDER_RULE: use this folder.')
    const first = build(dir)
    const second = build(dir)
    const session = await first.runtime.newSession(scope)
    await drain(session.send('original question'))
    await session.settle()
    const watching = await second.runtime.resumeSession(scope, session.id)
    await first.runtime.setSessionFolder(session.id, folder)
    expect((await first.runtime.loadSession(session.id))?.messages.some((m) => m.content.some((p) => p.type === 'text' && p.text.includes('original question')))).toBe(true)
    await drain(watching!.send('next question'))
    expect(watching!.id).toBe(session.id)
    expect(watching!.project).toMatchObject({ ok: true, project: { path: folder } })
    expect(second.provider.system).toContain('FOLDER_RULE')
    await watching!.settle()
    await second.runtime.setSessionFolder(session.id, null)
    await drain(session.send('back to default'))
    expect(session.project).toBeUndefined()
    expect(first.provider.system).not.toContain('FOLDER_RULE')
    expect((await first.runtime.loadSession(session.id))?.project).toBeUndefined()
    await session.settle()
  })

  it('refuses folder changes while another process holds the Session lease', async () => {
    const { runtime, store } = build(path.join(home, 'sessions-busy'))
    const session = await runtime.newSession(scope)
    const lease = await store.acquire(session.id)
    try {
      await expect(runtime.setSessionFolder(session.id, home)).rejects.toThrow('finish')
      expect((await store.load(session.id))?.project).toBeUndefined()
    } finally { await lease.release() }
  })

  it('uses the shared command to choose a folder without registering it twice', async () => {
    const { runtime } = build(path.join(home, 'sessions-command'))
    const session = await runtime.newSession(scope)
    const context = buildCommandContext({ runtime, scope, session })
    const folder = path.join(home, 'chosen')
    expect((await handleCommand(`/folder ${folder}`, context)).reply).toContain(folder)
    expect((await handleCommand(`/folder ${folder}`, context)).reply).toContain(folder)
    expect(readProjects().filter((project) => project.path === folder)).toHaveLength(1)
    expect((await handleCommand('/folder none', context)).reply).toContain('Default directory')
  })

  it('rejects a nonexistent folder without changing the Session', async () => {
    const { runtime } = build(path.join(home, 'sessions-missing'))
    const session = await runtime.newSession(scope)
    await expect(runtime.setSessionFolder(session.id, path.join(home, 'absent'))).rejects.toThrow()
    expect((await runtime.loadSession(session.id))?.project).toBeUndefined()
    expect((await runtime.loadSession(session.id))?.messages).toHaveLength(0)
  })
})
