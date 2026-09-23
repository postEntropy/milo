import { mkdtempSync } from 'node:fs'
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
const loadedConfig = (baseURL: string, apiKey: string | false = 'k'): LoadedConfig => ({
  config: {
    provider: 'test',
    model: 'test-model',
    providers: { test: { baseURL, wire: 'openai' } },
    memory: { backend: 'file' },
    sessions: { maxInputTokens: 12000, keepTurns: 8, compaction: true },
    display: { tools: 'full', thinking: true },
    gateways: {},
    permissions: { mode: 'auto', allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
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
})
