import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-providers-tool-'))
process.env.MILO_HOME = home

const { providersTool } = await import('../src/core/tools/providers.js')
const { readAuth, readConfig, saveAuth } = await import('../src/core/config/load.js')

function writeBaseConfig(): void {
  writeFileSync(
    path.join(home, 'config.yml'),
    stringify({
      provider: 'test',
      model: 'test-model',
      providers: { test: { name: 'Test', baseURL: 'https://provider.example/v1' } },
    }),
  )
}

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

describe('providers tool', () => {
  it('lists configured providers without exposing secret keys', async () => {
    writeBaseConfig()
    saveAuth({ providers: { test: 'super-secret-value' }, gateways: {}, search: {} })

    const res = await providersTool.execute(
      { action: 'list' },
      { cwd: home, signal: new AbortController().signal },
    )

    expect(res.isError).toBeUndefined()
    expect(res.content).toContain('test — Test')
    expect(res.content).toContain('key set')
    expect(res.content).not.toContain('super-secret-value')
  })

  it('probes a local llama.cpp-style /v1/models endpoint and rejects non-loopback HTTP', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            data: [
              { id: 'qwen2.5-coder-7b-instruct.gguf', context_length: 32768 },
              { id: 'llama-3.3-70b.gguf' },
            ],
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }
    const baseURL = `http://127.0.0.1:${address.port}/v1`

    try {
      const ok = await providersTool.execute(
        { action: 'test', baseURL },
        { cwd: home, signal: new AbortController().signal },
      )
      expect(ok.isError).toBeUndefined()
      expect(ok.content).toContain('qwen2.5-coder-7b-instruct.gguf')
      expect(ok.content).toContain('33k ctx')
      expect(ok.content).toContain('llama-3.3-70b.gguf')

      const bad = await providersTool.execute(
        { action: 'test', baseURL: 'http://example.com/v1' },
        { cwd: home, signal: new AbortController().signal },
      )
      expect(bad.isError).toBe(true)
      expect(bad.content).toContain('HTTPS')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('saves a keyless local provider, refreshes active runtime, and switches to it', async () => {
    writeBaseConfig()
    let refreshedId: string | null = null
    let used: { id: string; model?: string } | null = null
    const providerAdmin = {
      use: (id: string, model?: string) => {
        used = { id, model }
        return { provider: id, name: 'llama.cpp', model: model ?? 'qwen2.5.gguf' }
      },
      refreshIfActive: (id: string) => {
        refreshedId = id
      },
    }

    const saved = await providersTool.execute(
      {
        action: 'save',
        name: 'llama.cpp',
        baseURL: 'http://127.0.0.1:8080/v1',
        wire: 'openai',
        keyless: true,
      },
      { cwd: home, signal: new AbortController().signal, providerAdmin },
    )
    expect(saved.isError).toBeUndefined()
    expect(saved.content).toContain('Added custom provider "llama-cpp"')
    expect(saved.content).toContain('Ready to use (no API key required).')
    expect(refreshedId).toBe('llama-cpp')
    expect(readConfig()?.providers['llama-cpp']).toEqual({
      name: 'llama.cpp',
      baseURL: 'http://127.0.0.1:8080/v1',
      wire: 'openai',
      keyless: true,
    })

    const switched = await providersTool.execute(
      { action: 'use', id: 'llama-cpp', model: 'qwen2.5.gguf' },
      { cwd: home, signal: new AbortController().signal, providerAdmin },
    )
    expect(switched.isError).toBeUndefined()
    expect(switched.content).toContain('Switched active provider to llama.cpp (llama-cpp) using model qwen2.5.gguf.')
    expect(used).toEqual({ id: 'llama-cpp', model: 'qwen2.5.gguf' })
  })

  it('saves a keyed custom provider without taking an API key in chat and blocks switching until a key is set', async () => {
    writeBaseConfig()
    const providerAdmin = {
      use: (id: string, model?: string) => ({ provider: id, name: id, model: model ?? 'm' }),
      refreshIfActive: () => {},
    }

    const saved = await providersTool.execute(
      {
        action: 'save',
        name: 'Together AI',
        baseURL: 'https://api.together.xyz/v1',
        wire: 'openai',
        keyEnv: 'TOGETHER_API_KEY',
      },
      { cwd: home, signal: new AbortController().signal, providerAdmin },
    )
    expect(saved.isError).toBeUndefined()
    expect(saved.content).toContain('Settings → API keys')
    expect(readConfig()?.providers['together-ai']).toEqual({
      name: 'Together AI',
      baseURL: 'https://api.together.xyz/v1',
      wire: 'openai',
      keyEnv: 'TOGETHER_API_KEY',
    })

    // Cannot switch while neither auth.providers nor keyEnv holds a key.
    const blocked = await providersTool.execute(
      { action: 'use', id: 'together-ai' },
      { cwd: home, signal: new AbortController().signal, providerAdmin },
    )
    expect(blocked.isError).toBe(true)
    expect(blocked.content).toContain('no API key is set')

    // Removing the inactive custom provider cleans up config.
    const removed = await providersTool.execute(
      { action: 'remove', id: 'together-ai' },
      { cwd: home, signal: new AbortController().signal, providerAdmin },
    )
    expect(removed.isError).toBeUndefined()
    expect(readConfig()?.providers['together-ai']).toBeUndefined()
    expect(readAuth().providers['together-ai']).toBeUndefined()
  })
})
