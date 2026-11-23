import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DelegatedWorkStore } from '../src/core/delegated-work.js'
import { DelegatedScheduler } from '../src/core/delegated-scheduler.js'
import { AgentRuntime } from '../src/core/runtime.js'
import { DefaultPermissionPolicy, summarizeToolCall, withDelegatedGrants } from '../src/core/tools/permission.js'
import type { Tool } from '../src/core/tools/types.js'
import { runAgent } from '../src/core/agent/loop.js'
import { ToolRegistry } from '../src/core/tools/registry.js'
import { delegatedWorkTool } from '../src/core/tools/delegated-work.js'
import { createToolRegistry } from '../src/core/tools/index.js'
import { CrewStore } from '../src/core/crew.js'

const dirs: string[] = []
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'milo-work-'))
  dirs.push(dir)
  const file = join(dir, 'work.json')
  return { dir, file, store: new DelegatedWorkStore(file) }
}
const input = { name: 'Review', objective: 'Review the changes', target: { gateway: 'none' as const }, allow: [], originSessionId: 's' }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('delegated work', () => {
  it('claims an execution only once across stores and keeps its report', async () => {
    const { store, file } = setup()
    const work = await store.create(input)
    const claims = await Promise.all([store.claim(work.id, 1000), new DelegatedWorkStore(file).claim(work.id, 1000)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    await store.finish(work.id, claims.find(Boolean)!.run.id, { sessionId: 'run-session', report: 'Done' }, 2000)
    expect(store.list()[0]).toMatchObject({ state: 'completed', runs: [{ result: 'completed', report: 'Done', sessionId: 'run-session' }] })
  })

  it('pauses after a running check and resumes it explicitly', async () => {
    const { store } = setup()
    const work = await store.create({ ...input, schedule: { kind: 'every', minutes: 60 } })
    const run = (await store.claim(work.id, 1000))!.run
    expect((await store.control(work.id, 'pause')).pauseAfterRun).toBe(true)
    expect((await store.finish(work.id, run.id, { report: 'Checked' }, 2000)).state).toBe('paused')
    expect((await store.control(work.id, 'resume')).state).toBe('queued')
    const next = (await store.claim(work.id, 3000))!.run
    expect((await store.finish(work.id, next.id, { report: 'Checked again' }, 4000))).toMatchObject({ state: 'waiting', nextAt: 3604000 })
  })

  it('keeps cancellation when a running execution finishes', async () => {
    const { store } = setup()
    const work = await store.create(input)
    const run = (await store.claim(work.id, 1000))!.run
    await store.control(work.id, 'cancel')
    const result = await store.finish(work.id, run.id, { report: 'partial' }, 2000)
    expect(result).toMatchObject({ state: 'cancelled', runs: [{ result: 'cancelled' }] })
    await expect(store.control(work.id, 'resume')).rejects.toThrow('cannot be resumed')
  })

  it('recovers abandoned work and skips missed scheduled times', async () => {
    const { store, file } = setup()
    const work = await store.create(input)
    await store.claim(work.id, 1000)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw[0].runs[0].processId = 2147483647
    writeFileSync(file, JSON.stringify(raw))
    await store.recover(3000)
    expect(store.list()[0]).toMatchObject({ state: 'interrupted', runs: [{ result: 'interrupted' }] })
    expect((await store.control(work.id, 'resume')).state).toBe('queued')
  })

  it('recovers a run when its process id belongs to a different process', async () => {
    const { store, file } = setup()
    const work = await store.create(input)
    await store.claim(work.id, 1000)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw[0].runs[0].processIdentity) return
    raw[0].runs[0].processIdentity = 'a-different-process'
    writeFileSync(file, JSON.stringify(raw))
    await store.recover(3000)
    expect(store.list()[0]).toMatchObject({ state: 'interrupted', runs: [{ result: 'interrupted' }] })
  })

  it('waits for a claim in progress before shutdown settles', async () => {
    const { store } = setup()
    const work = await store.create(input)
    const claim = store.claim.bind(store)
    let release!: () => void
    let entered!: () => void
    const enteredClaim = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    store.claim = async (id, now) => { entered(); await gate; return claim(id, now) }
    const scheduler = new DelegatedScheduler({ store, runtime: {} as AgentRuntime, deliver: async () => {}, log: () => {} })
    const starting = scheduler.start()
    await enteredClaim
    scheduler.stop()
    let settled = false
    const waiting = scheduler.settle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await Promise.all([starting, waiting])
    expect(store.list().find((item) => item.id === work.id)?.state).toBe('failed')
  })

  it('skips missed recurring times and preserves the next future occurrence', async () => {
    const { store } = setup()
    const work = await store.create({ ...input, schedule: { kind: 'every', minutes: 1 } })
    const run = (await store.claim(work.id, 1000))!.run
    await store.finish(work.id, run.id, { report: 'Checked' }, 2000)
    await store.recover(200000)
    expect(store.list()[0]).toMatchObject({ state: 'waiting', nextAt: 260000 })
    expect(await store.claim(work.id, 200000)).toBeNull()
  })

  it('schedules the next check after an ongoing run is interrupted', async () => {
    const { store, file } = setup()
    const work = await store.create({ ...input, schedule: { kind: 'every', minutes: 1 } })
    await store.claim(work.id, 1000)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw[0].runs[0].processId = 2147483647
    writeFileSync(file, JSON.stringify(raw))
    await store.recover(3000)
    expect(store.list()[0]).toMatchObject({ state: 'waiting', nextAt: 63000, runs: [{ result: 'interrupted' }] })
  })

  it('edits an idle objective and refuses edits during a run', async () => {
    const { store } = setup()
    const work = await store.create(input)
    expect((await store.edit(work.id, { objective: 'New objective', schedule: { kind: 'every', minutes: 5 } })).objective).toBe('New objective')
    await store.claim(work.id, 1000)
    await expect(store.edit(work.id, { objective: 'Too late' })).rejects.toThrow('current run')
  })

  it('runs a queued objective in its own Session and records the result', async () => {
    const { dir, store } = setup()
    const work = await store.create(input)
    const runtime = new AgentRuntime({
      provider: { id: 'stub', async *stream() { yield { type: 'text', delta: 'The report' }; yield { type: 'done', finishReason: 'stop' } } },
      model: 'test', system: '', cwd: dir,
      registry: { specs: () => [] } as never,
      memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
    })
    const errors: string[] = []
    const scheduler = new DelegatedScheduler({ store, runtime, deliver: async () => {}, log: (line) => errors.push(line) })
    await scheduler.start()
    await scheduler.settle()
    scheduler.stop()
    expect(errors).toEqual([])
    expect(store.list().find((item) => item.id === work.id)).toMatchObject({ state: 'completed', runs: [{ report: 'The report', result: 'completed', sessionId: expect.any(String) }] })
    await runtime.close()
  })

  it('aborts a running objective when cancellation is requested from another store', async () => {
    const { dir, file, store } = setup()
    const work = await store.create(input)
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const runtime = new AgentRuntime({
      provider: { id: 'slow', async *stream(request) {
        started()
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }))
        throw new DOMException('Stopped', 'AbortError')
      } },
      model: 'test', system: '', cwd: dir,
      registry: { specs: () => [] } as never,
      memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
    })
    const errors: string[] = []
    const scheduler = new DelegatedScheduler({ store, runtime, deliver: async () => {}, log: (line) => errors.push(line) })
    await scheduler.start()
    await ready
    await new DelegatedWorkStore(file).control(work.id, 'cancel')
    await scheduler.settle()
    scheduler.stop()
    expect(errors).toEqual([])
    expect(store.list()[0]).toMatchObject({ state: 'cancelled', runs: [{ result: 'cancelled' }] })
    await runtime.close()
  })

  it('records the bots created by an unattended work run', async () => {
    const { dir, store } = setup()
    const work = await store.create(input)
    const crew = new CrewStore(join(dir, 'crew.json'))
    let calls = 0
    const runtime = new AgentRuntime({
      provider: { id: 'stub', async *stream() {
        if (calls++ === 0) {
          yield { type: 'tool-call', id: 'task', name: 'task', args: { name: 'Scout', description: 'Inspect', prompt: 'Inspect the tests' } }
          yield { type: 'done', finishReason: 'tool_calls' }
        } else {
          yield { type: 'text', delta: calls === 2 ? 'Bot report' : 'Final report' }
          yield { type: 'done', finishReason: 'stop' }
        }
      } },
      model: 'test', system: '', cwd: dir, crew, registry: createToolRegistry(),
      memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
    })
    const errors: string[] = []
    const scheduler = new DelegatedScheduler({ store, runtime, deliver: async () => {}, log: (line) => errors.push(line) })
    await scheduler.start(); await scheduler.settle(); scheduler.stop()
    const run = store.list().find((item) => item.id === work.id)!.runs[0]!
    expect(run).toMatchObject({ result: 'completed', report: 'Final report' })
    expect(crew.list({ includeArchived: true })).toMatchObject([{ name: 'Scout', assignments: [{ sessionId: run.sessionId, report: 'Bot report', state: 'completed' }] }])
    expect(errors).toEqual([])
    await runtime.close()
  })

  it('records a delivery failure without losing the completed report', async () => {
    const { dir, store } = setup()
    await store.create({ ...input, target: { gateway: 'web', chatId: 'chat' } })
    const runtime = new AgentRuntime({
      provider: { id: 'stub', async *stream() { yield { type: 'text', delta: 'The report' }; yield { type: 'done', finishReason: 'stop' } } },
      model: 'test', system: '', cwd: dir, registry: { specs: () => [] } as never,
      memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
    })
    const errors: string[] = []
    const scheduler = new DelegatedScheduler({ store, runtime, deliver: async () => { throw new Error('Disconnected') }, log: (line) => errors.push(line) })
    await scheduler.start(); await scheduler.settle(); scheduler.stop()
    expect(store.list()[0]?.runs[0]).toMatchObject({ result: 'completed', report: 'The report', deliveryError: 'Disconnected' })
    expect(errors[0]).toContain('Disconnected')
    await runtime.close()
  })

  it('enforces the work’s own grants in the running Session', async () => {
    const attempt = async (allow: string[]) => {
      const { dir, store } = setup()
      await store.create({ ...input, allow })
      let executed = false
      const write: Tool = { name: 'fake_write', description: '', schema: z.object({}), async execute() { executed = true; return { content: 'written' } } }
      let calls = 0
      const runtime = new AgentRuntime({
        provider: { id: 'stub', async *stream() {
          if (calls++ === 0) { yield { type: 'tool-call', id: 'write', name: 'fake_write', args: {} }; yield { type: 'done', finishReason: 'tool_calls' } }
          else { yield { type: 'text', delta: 'Finished' }; yield { type: 'done', finishReason: 'stop' } }
        } },
        model: 'test', system: '', cwd: dir, registry: new ToolRegistry([write]),
        permissionPolicy: new DefaultPermissionPolicy({ mode: 'yolo' }),
        memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
      })
      const scheduler = new DelegatedScheduler({ store, runtime, deliver: async () => {}, log: () => {} })
      await scheduler.start(); await scheduler.settle(); scheduler.stop(); await runtime.close()
      return executed
    }
    expect(await attempt([])).toBe(false)
    expect(await attempt(['fake_write'])).toBe(true)
  })
})

describe('delegated work permissions', () => {
  const sideEffect: Tool = { name: 'write_file', description: '', schema: z.object({}), async execute() { return { content: '' } } }
  const send: Tool = { ...sideEffect, name: 'gmail_send' }

  it('requires a grant even in unrestricted mode and preserves explicit denies', async () => {
    const unrestricted = new DefaultPermissionPolicy({ mode: 'yolo', deny: ['write_file'] })
    expect(await withDelegatedGrants(unrestricted, ['write_file'], '/tmp').decide(sideEffect, {})).toBe('deny')
    const policy = new DefaultPermissionPolicy({ mode: 'yolo' })
    expect(await withDelegatedGrants(policy, [], '/tmp').decide(sideEffect, {})).toBe('deny')
    expect(await withDelegatedGrants(policy, ['write_file'], '/tmp').decide(sideEffect, {})).toBe('allow')
    expect(await withDelegatedGrants(policy, ['gmail_send'], '/tmp').decide(send, {})).toBe('deny')
  })

  it('asks before saving standing grants even in unrestricted mode', async () => {
    const { store } = setup()
    let calls = 0
    const provider = { id: 'script', async *stream() {
      if (calls++ === 0) {
        yield { type: 'tool-call' as const, id: 'call', name: 'delegated_work', args: { action: 'create', name: 'Review', objective: 'Check files', allow: ['shell_command'] } }
        yield { type: 'done' as const, finishReason: 'tool_calls' as const }
      } else yield { type: 'done' as const, finishReason: 'stop' as const }
    } }
    const registry = new ToolRegistry([delegatedWorkTool])
    let summary = ''
    for await (const _event of runAgent({
      provider, model: 'm', registry, tools: registry.specs(), messages: [],
      context: { cwd: '/tmp', signal: new AbortController().signal, delegatedWork: store, sessionId: 's' },
      permission: { policy: new DefaultPermissionPolicy({ mode: 'yolo' }), ask: async (request) => { summary = request.summary; return { allowed: false } } },
    })) { /* drain */ }
    expect(summary).toContain('Objective: Check files')
    expect(summary).toContain('Unattended tools: shell_command')
    expect(store.list()).toEqual([])
  })

  it('shows the full recipient, subject and body before sending mail', () => {
    const body = 'A'.repeat(700)
    const summary = summarizeToolCall({ to: 'recipient@example.com', subject: 'Subject', body, command: 'misleading' }, 'gmail_send')
    expect(summary).toContain('recipient@example.com')
    expect(summary).toContain('Subject')
    expect(summary).toContain(body)
    expect(summary).not.toContain('misleading')
  })

  it('uses standing grants only for mail actions that permit them', async () => {
    const run = async (name: string, standing: string[], mayStand: boolean) => {
      let calls = 0
      let executed = false
      const tool: Tool = { name, description: '', schema: z.object({}), requiresConfirmation: () => true, allowStandingConfirmation: mayStand, async execute() { executed = true; return { content: 'done' } } }
      const registry = new ToolRegistry([tool])
      const provider = { id: 'script', async *stream() {
        if (calls++ === 0) { yield { type: 'tool-call' as const, id: 'call', name, args: {} }; yield { type: 'done' as const, finishReason: 'tool_calls' as const } }
        else yield { type: 'done' as const, finishReason: 'stop' as const }
      } }
      for await (const _event of runAgent({ provider, model: 'm', registry, tools: registry.specs(), messages: [],
        context: { cwd: '/tmp', signal: new AbortController().signal, standingGrants: standing },
        permission: { policy: new DefaultPermissionPolicy({ mode: 'yolo' }) },
      })) { /* drain */ }
      return executed
    }
    expect(await run('gmail_modify', [], true)).toBe(false)
    expect(await run('gmail_modify', ['gmail_modify'], true)).toBe(true)
    expect(await run('gmail_send', ['gmail_send'], false)).toBe(false)
  })

  it('shows the resolved project folder path when confirming resume or update', async () => {
    const { store } = setup()
    const work = await store.create({ ...input, project: 'proj-1' })
    await store.control(work.id, 'pause')
    let calls = 0
    const provider = { id: 'script', async *stream() {
      if (calls++ === 0) {
        yield { type: 'tool-call' as const, id: 'call', name: 'delegated_work', args: { action: 'resume', id: work.id } }
        yield { type: 'done' as const, finishReason: 'tool_calls' as const }
      } else yield { type: 'done' as const, finishReason: 'stop' as const }
    } }
    const registry = new ToolRegistry([delegatedWorkTool])
    let summary = ''
    for await (const _event of runAgent({
      provider, model: 'm', registry, tools: registry.specs(), messages: [],
      context: { cwd: '/tmp', signal: new AbortController().signal, delegatedWork: store, sessionId: 's', resolveProjectPath: (id) => id === 'proj-1' ? '/srv/repos/milo' : undefined },
      permission: { policy: new DefaultPermissionPolicy({ mode: 'yolo' }), ask: async (request) => { summary = request.summary; return { allowed: false } } },
    })) { /* drain */ }
    expect(summary).toContain('Folder: /srv/repos/milo')
    expect(summary).not.toContain('Folder: proj-1')
  })

  it('rejects invalid delegated_work tool requests before asking confirmation and executes lifecycle actions', async () => {
    const { store } = setup()
    let asked = 0
    const runTool = async (args: Record<string, unknown>) => {
      let calls = 0
      const toolResults: string[] = []
      const provider = { id: 'script', async *stream() {
        if (calls++ === 0) {
          yield { type: 'tool-call' as const, id: 'call', name: 'delegated_work', args }
          yield { type: 'done' as const, finishReason: 'tool_calls' as const }
        } else yield { type: 'done' as const, finishReason: 'stop' as const }
      } }
      const registry = new ToolRegistry([delegatedWorkTool])
      for await (const event of runAgent({
        provider, model: 'm', registry, tools: registry.specs(), messages: [],
        context: { cwd: '/tmp', signal: new AbortController().signal, delegatedWork: store, sessionId: 's' },
        permission: {
          policy: new DefaultPermissionPolicy({ mode: 'yolo' }),
          ask: async () => { asked += 1; return { allowed: true } },
        },
      })) {
        if (event.type === 'tool-end') toolResults.push(event.result)
      }
      return toolResults
    }

    const deniedSend = await runTool({ action: 'create', name: 'Mail', objective: 'Send', allow: ['gmail_send'], target: { gateway: 'none' } })
    expect(asked).toBe(0)
    expect(deniedSend[0]).toContain('cannot be granted')

    const missingId = await runTool({ action: 'resume', id: 'no-such-work' })
    expect(asked).toBe(0)
    expect(missingId[0]).toContain('No delegated work')

    const created = await runTool({ action: 'create', name: 'Sweep', objective: 'Check repo', allow: ['gmail_modify'], target: { gateway: 'none' } })
    expect(asked).toBe(1)
    expect(created[0]).toContain('Sweep')
    const id = store.list()[0]!.id
    await runTool({ action: 'update', id, objective: 'Check tests too' })
    await runTool({ action: 'pause', id })
    expect(store.list()[0]).toMatchObject({ objective: 'Check tests too', state: 'paused' })
    await runTool({ action: 'cancel', id })
    expect(store.list()[0]?.state).toBe('cancelled')
  })

  it('recovers orphaned running work whose current run is absent', async () => {
    const { store, file } = setup()
    const work = await store.create(input)
    await store.claim(work.id, 1000)
    // Simulate a truncated/legacy file where work says running without an active run record
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    raw[0]!.runs = []
    writeFileSync(file, JSON.stringify(raw))
    const reloaded = new DelegatedWorkStore(file)
    await reloaded.recover(2000)
    expect(reloaded.list()[0]).toMatchObject({ state: 'interrupted' })
  })

  it('keeps prior reports without overwriting them on failure and enforces strictProject', async () => {
    const { store } = setup()
    const work = await store.create({ ...input, objective: 'Run checks', schedule: { kind: 'every', minutes: 5 } })
    const claimed1 = await store.claim(work.id, 1000)
    await store.finish(work.id, claimed1!.run.id, { sessionId: 's1', report: 'Clean first run' }, 2000)
    const claimed2 = await store.claim(work.id, 305_000)
    await store.finish(work.id, claimed2!.run.id, { sessionId: 's2', report: '', failure: 'Gateway timeout' }, 306_000)
    expect(store.list()[0]?.runs[1]).toMatchObject({ result: 'failed', failure: 'Gateway timeout', report: '' })

    const { dir } = setup()
    const strictWork = await store.create({ ...input, project: 'missing-project-folder' })
    const runtime = new AgentRuntime({
      provider: { id: 'stub', async *stream() { yield { type: 'done', finishReason: 'stop' } } },
      model: 'test', system: '', cwd: dir,
      registry: { specs: () => [] } as never,
      memory: { remember: async () => undefined, recall: async () => [], list: async () => [], forget: async () => false } as never,
    })
    const scheduler = new DelegatedScheduler({ store, runtime, deliver: async () => undefined, log: () => undefined })
    await scheduler.start()
    await scheduler.settle()
    scheduler.stop()
    await runtime.close()
    expect(store.list().find((item) => item.id === strictWork.id)).toMatchObject({
      state: 'failed',
      runs: [{ result: 'failed', failure: 'No project with the id missing-project-folder.' }],
    })
  })
})
