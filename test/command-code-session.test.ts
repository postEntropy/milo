import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HerdrCommandCodeSessionDriver } from '../src/core/command-code-session.js'
import type { AgentEvent } from '../src/core/agent/events.js'
import type { SessionRecord } from '../src/core/sessions/types.js'

const nativeSessionId = '7f83d2b4-a4ab-4e3a-8e6d-16d5cb2e9b20'
const fixture = new URL('./fixtures/command-code-session.jsonl', import.meta.url)
const homes: string[] = []

function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'milo-command-code-driver-'))
  homes.push(home)
  const projectDirectory = path.join(home, '.commandcode', 'projects', 'project-slug')
  mkdirSync(projectDirectory, { recursive: true })
  const transcriptPath = path.join(projectDirectory, `${nativeSessionId}.jsonl`)
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let nextTurn = 0
  let finalText = 'Done.'
  let terminalState: 'live' | 'finished' = 'finished'
  let runGate: Promise<void> | undefined
  let openRunGate: (() => void) | undefined
  let reportRunStarted!: () => void
  const runStarted = new Promise<void>((resolve) => { reportRunStarted = resolve })
  const terminalList: Record<string, unknown>[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ method, params })
    if (method === 'terminal.list') {
      const wanted = params.labels as Record<string, string>
      return { terminals: terminalList.filter((terminal) => Object.entries(wanted).every(([key, value]) => (terminal.labels as Record<string, string>)[key] === value)) }
    }
    if (method === 'terminal.run') {
      reportRunStarted()
      if (runGate) await runGate
      nextTurn += 1
      const labels = params.labels as Record<string, string>
      const terminal = {
        address: `t${nextTurn}`,
        state: terminalState,
        created_ms: 1793880000000 + nextTurn,
        cwd: '/project',
        labels,
        exit_code: 0,
        reason: 'exited',
      }
      terminalList.push(terminal)
      return terminal
    }
    if (method === 'terminal.read') {
      if (!exists(transcriptPath)) copyFileSync(fixture, transcriptPath)
      else if (nextTurn > 1) appendFollowup(transcriptPath)
      return {
        text: `${JSON.stringify({ type: 'event', event: { type: 'tool_running', toolName: 'write_file' } })}\n${JSON.stringify({ type: 'result', subtype: 'success', sessionId: nativeSessionId, stopReason: 'end_turn', finalText })}\n`,
        complete: true,
        how: 'history',
        why: null,
      }
    }
    if (method === 'terminal.wait') return { ended: true }
    if (method === 'terminal.get') return {
      address: params.terminal,
      state: 'finished',
      created_ms: 1793880000000,
      cwd: '/project',
      labels: {},
      exit_code: 0,
      reason: 'exited',
    }
    if (method === 'terminal.kill') return { killed: true }
    throw new Error(`Unexpected Herdr method ${method}`)
  })
  return {
    home,
    projectDirectory,
    transcriptPath,
    calls,
    call,
    setTurn: (value: number) => { nextTurn = value },
    setFinalText: (value: string) => { finalText = value },
    setTerminals: (items: Record<string, unknown>[]) => { terminalList.splice(0, terminalList.length, ...items) },
    setTerminalState: (value: 'live' | 'finished') => { terminalState = value },
    holdTerminalRun: () => {
      runGate = new Promise<void>((resolve) => { openRunGate = resolve })
      return runStarted
    },
    releaseTerminalRun: () => { openRunGate?.(); runGate = undefined },
  }
}

function exists(file: string): boolean {
  try { return Boolean(statSync(file)) } catch { return false }
}

function appendFollowup(file: string): void {
  const previous = 'assistant-2'
  const user = {
    type: 'message',
    id: 'user-2',
    parentId: previous,
    timestamp: '2026-11-05T12:01:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Continue the source file.' }], meta: { source: 'user', createdAt: 1793880060000, messageId: 'message-user-2' } },
  }
  const assistant = {
    type: 'message',
    id: 'assistant-3',
    parentId: 'user-2',
    timestamp: '2026-11-05T12:01:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Continued.' }], meta: { source: 'model', createdAt: 1793880061000, messageId: 'message-assistant-3' }, usage: { inputTokens: 10, outputTokens: 2 }, model: 'test-model', effort: 'medium' },
  }
  const current = require('node:fs').readFileSync(file, 'utf8') as string
  if (current.includes('assistant-3')) return
  appendFileSync(file, `${JSON.stringify(user)}\n${JSON.stringify(assistant)}\n`)
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('Herdr Command Code Session backend', () => {
  it('starts the first native thread and keeps its transcript outside Milo messages', async () => {
    const { home, calls, call } = setup()
    const driver = new HerdrCommandCodeSessionDriver({ home, call, checkCommandCode: async () => undefined })
    const record: SessionRecord = {
      id: 'calm-otter-7',
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      messages: [],
      project: 'calm-otter-8',
      backend: {
        kind: 'command-code',
        state: 'running',
        nativeTitle: 'Milo Session calm-otter-7',
        requestId: 'web:chat-id',
        workingDirectory: '/project',
        projectIncarnation: 'project-generation-1',
        pendingTurn: { id: 'turn-1', input: 'Create a source file.', startedAt: 10, baseMessageCount: 0 },
      },
    }

    const events: AgentEvent[] = []
    const result = await (async () => {
      const stream = driver.send(record, 'Create a source file.', { newTurn: true })
      let completed = await stream.next()
      while (!completed.done) {
        events.push(completed.value)
        completed = await stream.next()
      }
      return completed.value
    })()

    expect(result.backend.nativeSessionId).toBe(nativeSessionId)
    expect(result.history.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(record.messages).toEqual([])
    expect(events).toContainEqual({ type: 'text-delta', delta: 'Done.' })
    const run = calls.find((entry) => entry.method === 'terminal.run')
    expect(run?.params).toMatchObject({
      cwd: '/project',
      wait: false,
      no_parent: true,
      outlive_parent: true,
      name: expect.stringMatching(/^milo-/),
    })
    expect(run?.params.argv).toEqual([
      'cmd', '-p', '--output-format', 'json', '--yolo', '--skip-onboarding', '--name', 'Milo Session calm-otter-7', 'Create a source file.',
    ])
  })

  it('resumes the same native thread for follow-up messages', async () => {
    const { home, transcriptPath, calls, call, setTurn, setFinalText } = setup()
    copyFileSync(fixture, transcriptPath)
    setTurn(1)
    setFinalText('Continued.')
    const driver = new HerdrCommandCodeSessionDriver({ home, call, checkCommandCode: async () => undefined })
    const record: SessionRecord = {
      id: 'calm-otter-7',
      createdAt: 1,
      updatedAt: 1,
      version: 2,
      messages: [],
      project: 'calm-otter-8',
      backend: {
        kind: 'command-code',
        state: 'ready',
        nativeSessionId,
        nativeTitle: 'Milo Session calm-otter-7',
        requestId: 'web:chat-id',
        workingDirectory: '/project',
        projectIncarnation: 'project-generation-1',
        pendingTurn: { id: 'turn-2', input: 'Continue the source file.', startedAt: 20, baseMessageCount: 4 },
      },
    }

    const stream = driver.send(record, 'Continue the source file.', { newTurn: true })
    let result = await stream.next()
    while (!result.done) result = await stream.next()

    expect(result.value.backend.nativeSessionId).toBe(nativeSessionId)
    expect(result.value.history.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Continued.' }])
    expect(calls.find((entry) => entry.method === 'terminal.run')?.params.argv).toEqual([
      'cmd', '-p', '--output-format', 'json', '--yolo', '--skip-onboarding', '--resume', nativeSessionId, 'Continue the source file.',
    ])
  })

  it('stops a terminal created while removal waited for the launch lock', async () => {
    const { home, calls, call, setTerminalState, holdTerminalRun, releaseTerminalRun } = setup()
    setTerminalState('live')
    const runStarted = holdTerminalRun()
    const driver = new HerdrCommandCodeSessionDriver({ home, call, checkCommandCode: async () => undefined })
    const record: SessionRecord = {
      id: 'calm-otter-7',
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      messages: [],
      backend: {
        kind: 'command-code',
        state: 'running',
        nativeTitle: 'Milo Session calm-otter-7',
        requestId: 'web:chat-id',
        workingDirectory: '/project',
        pendingTurn: { id: 'turn-1', input: 'Create a source file.', startedAt: 10, baseMessageCount: 0 },
      },
    }
    const sending = (async () => {
      for await (const _event of driver.send(record, 'Create a source file.', { newTurn: true })) { /* drain */ }
    })()

    await runStarted
    const stopping = driver.stop(record)
    releaseTerminalRun()
    await Promise.all([sending, stopping])

    expect(calls.some((entry) => entry.method === 'terminal.kill')).toBe(true)
    expect(calls.filter((entry) => entry.method === 'terminal.run')).toHaveLength(1)
  })

  it('refuses to start a terminal after the Session has been marked for removal', async () => {
    const { home, calls, call } = setup()
    const driver = new HerdrCommandCodeSessionDriver({ home, call, checkCommandCode: async () => undefined })
    const record: SessionRecord = {
      id: 'calm-otter-7',
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      messages: [],
      backend: {
        kind: 'command-code',
        state: 'error',
        nativeTitle: 'Milo Session calm-otter-7',
        requestId: 'web:chat-id',
        workingDirectory: '/project',
        pendingTurn: { id: 'turn-1', input: 'Create a source file.', startedAt: 10, baseMessageCount: 0 },
      },
    }

    await driver.stop(record)
    await expect(driver.send(record, 'Create a source file.', { retryPending: true }).next())
      .rejects.toThrow('is being removed')
    expect(calls.some((entry) => entry.method === 'terminal.run')).toBe(false)
  })

  it('keeps a matching native transcript uncertain when Herdr has no matching terminal', async () => {
    const { home, transcriptPath, calls, call } = setup()
    copyFileSync(fixture, transcriptPath)
    appendFollowup(transcriptPath)
    const driver = new HerdrCommandCodeSessionDriver({ home, call, checkCommandCode: async () => undefined })
    const pendingTurn = { id: 'turn-2', input: 'Continue the source file.', startedAt: 20, baseMessageCount: 4 }
    const record: SessionRecord = {
      id: 'calm-otter-7',
      createdAt: 1,
      updatedAt: 1,
      version: 2,
      messages: [],
      backend: {
        kind: 'command-code',
        state: 'error',
        nativeSessionId,
        nativeTitle: 'Milo Session calm-otter-7',
        requestId: 'web:chat-id',
        workingDirectory: '/project',
        pendingTurn,
      },
    }

    const stream = driver.send(record, pendingTurn.input)
    let result = await stream.next()
    while (!result.done) result = await stream.next()

    expect(result.value.error).toContain('No Herdr terminal can confirm')
    expect(result.value.backend.pendingTurn).toEqual(pendingTurn)
    expect(calls.some((entry) => entry.method === 'terminal.run')).toBe(false)
  })

  it('reconciles a completed native turn instead of starting it twice', async () => {
    const { home, transcriptPath, calls, call, setFinalText, setTerminals } = setup()
    copyFileSync(fixture, transcriptPath)
    appendFollowup(transcriptPath)
    setFinalText('Continued.')
    setTerminals([{
      address: 't999',
      state: 'finished',
      created_ms: 1793880062000,
      cwd: '/project',
      labels: { 'milo-session-id': 'calm-otter-7', 'milo-turn-id': 'turn-2', 'milo-agent': 'command-code-session' },
      exit_code: 0,
      reason: 'exited',
    }])
    const driver = new HerdrCommandCodeSessionDriver({ home, call, checkCommandCode: async () => undefined })
    const record: SessionRecord = {
      id: 'calm-otter-7',
      createdAt: 1,
      updatedAt: 1,
      version: 2,
      messages: [],
      backend: {
        kind: 'command-code',
        state: 'error',
        nativeSessionId,
        nativeTitle: 'Milo Session calm-otter-7',
        requestId: 'web:chat-id',
        workingDirectory: '/project',
        pendingTurn: { id: 'turn-2', input: 'Continue the source file.', startedAt: 20, baseMessageCount: 4 },
      },
    }

    const stream = driver.send(record, 'Continue the source file.')
    let result = await stream.next()
    while (!result.done) result = await stream.next()

    expect(result.value.history.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Continued.' }])
    expect(result.value.backend.pendingTurn).toBeUndefined()
    expect(calls.some((entry) => entry.method === 'terminal.run')).toBe(false)
  })
})
