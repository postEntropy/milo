import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { LoadedConfig } from '../src/core/config/load.js'
import type { Tool } from '../src/core/tools/types.js'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-bootstrap-'))
process.env.MILO_HOME = home

const { createRuntime } = await import('../src/core/bootstrap.js')

const writeTool = {
  name: 'shell_command',
  description: '',
  schema: z.object({ command: z.string() }),
  async execute() {
    return { content: '' }
  },
} satisfies Tool<{ command: string }>

/** One config, varying only where the provider lives and whether it has a key. */
const loadedConfig = (
  baseURL: string,
  apiKey: string | false = 'k',
  browser = false,
): LoadedConfig => ({
  config: {
    provider: 'test',
    model: 'test-model',
    providers: { test: { baseURL, wire: 'openai' } },
    memory: { derive: false },
    sessions: { compactAt: 0.7, maxInputTokens: 12000, keepTurns: 8, compaction: true, maxSessions: 50 },
    history: { windowDays: 365 },
    display: { tools: 'full', thinking: 'on' },
    reasoningEffort: 'medium',
    gateways: {},
    web: { enabled: true, host: '127.0.0.1', port: 7717 },
    permissions: { mode: 'auto', allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
    browser: {
      enabled: browser,
      chromePath: null,
      headless: true,
      profileDir: null,
      cdpUrl: null,
      keepSnapshots: 2,
    },
  },
  provider: { id: 'test', baseURL, apiKey, wire: 'openai' },
  model: 'test-model',
})

const noul = (probability: number) =>
  vi.fn(
    async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ answers: { dangerous: { noul: probability } } }), {
        status: 200,
      }),
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createRuntime', () => {
  it('wires sessions, memory and the permission policy together', async () => {
    const runtime = createRuntime(loadedConfig('https://x.test/v1'), process.cwd())
    const session = await runtime.getSession({ gateway: 'cli', conversationId: 't' })

    expect(session.id).toMatch(/^[a-z]+-[a-z]+-\d{1,3}$/)
    expect(runtime.permissions?.mode).toBe('auto')
  })

  it('judges the grey zone with the reviewer on Command Code', async () => {
    const fetchMock = noul(0.1)
    vi.stubGlobal('fetch', fetchMock)

    const runtime = createRuntime(
      loadedConfig('https://api.commandcode.ai/provider/v1'),
      process.cwd(),
    )
    expect(await runtime.permissions?.decide(writeTool, { command: 'npm test' })).toBe('allow')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('asks instead of reviewing anywhere else', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const runtime = createRuntime(loadedConfig('https://api.openai.com/v1'), process.cwd())
    expect(await runtime.permissions?.decide(writeTool, { command: 'npm test' })).toBe('ask')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('has no reviewer without an API key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const runtime = createRuntime(
      loadedConfig('https://api.commandcode.ai/provider/v1', false),
      process.cwd(),
    )
    expect(await runtime.permissions?.decide(writeTool, { command: 'npm test' })).toBe('ask')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('closes cleanly when nothing was ever used', async () => {
    const runtime = createRuntime(loadedConfig('https://x.test/v1'), process.cwd())
    const session = await runtime.getSession({ gateway: 'cli', conversationId: 'idle' })

    expect(session.id).toMatch(/^[a-z]+-[a-z]+-\d{1,3}$/)
    await expect(runtime.close()).resolves.toBeUndefined()
  })

  it('builds a browser only when the config turned one on', async () => {
    const off = createRuntime(loadedConfig('https://x.test/v1'), process.cwd())
    expect(off.browser).toBeNull()
    // And closing an install that never started one is not a thing that hangs.
    await expect(off.close()).resolves.toBeUndefined()

    const on = createRuntime(loadedConfig('https://x.test/v1', 'k', true), process.cwd())
    expect(on.browser).not.toBeNull()
    // Nothing is launched until a tool is called, so this costs no process.
    expect(on.browser?.isRunning).toBe(false)
    await expect(on.close()).resolves.toBeUndefined()
  })

  it('begins a new conversation on a new run, and keeps the one it left', async () => {
    const cli = { gateway: 'cli', conversationId: 'restart' }

    const run = createRuntime(loadedConfig('https://x.test/v1'), process.cwd())
    const opened = await run.sessionFor(cli)
    // The same run keeps talking in the conversation it opened.
    expect((await run.sessionFor(cli)).id).toBe(opened.id)

    // A restart is a second run over the same home, and it opens its own.
    await run.close()
    const restarted = createRuntime(loadedConfig('https://x.test/v1'), process.cwd())
    const afterRestart = await restarted.sessionFor(cli)

    expect(afterRestart.id).not.toBe(opened.id)
    // What the closed run left behind is still on disk, to be resumed.
    const listed = await restarted.listSessions()
    expect(listed.some((entry) => entry.id === opened.id)).toBe(true)
    await restarted.close()
  })

  it('writes a turn to the history log of the home it was built for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: string | URL, _init?: RequestInit) =>
          new Response(
            'data: {"choices":[{"delta":{"content":"hi there"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    )

    const runtime = createRuntime(loadedConfig('https://x.test/v1'), process.cwd())
    const session = await runtime.getSession({ gateway: 'cli', conversationId: 'history' })
    for await (const _event of session.send('write this down')) {
      // drain
    }

    const dir = path.join(home, 'history')
    const [file] = readdirSync(dir).sort()
    const log = readFileSync(path.join(dir, file!), 'utf8').trim().split('\n')

    expect(file).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)
    expect(log).toHaveLength(2)
    expect(JSON.parse(log[0]!)).toMatchObject({
      kind: 'user',
      text: 'write this down',
      session: session.id,
    })
    expect(JSON.parse(log[1]!)).toMatchObject({ kind: 'assistant', text: 'hi there' })
  })
})
