import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-core-settings-'))
process.env.MILO_HOME = home

const {
  saveSecret,
  removeSecret,
  saveCustomProvider,
  removeCustomProvider,
} = await import('../src/core/settings.js')
const { readAuth, readConfig } = await import('../src/core/config/load.js')

function writeBaseConfig(): void {
  writeFileSync(
    path.join(home, 'config.yml'),
    stringify({
      provider: 'test',
      model: 'test-model',
      providers: { test: { baseURL: 'https://provider.example/v1' } },
    }),
  )
}

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

describe('core settings operations', () => {
  it('saves and removes secrets across groups', () => {
    writeBaseConfig()
    const saved = saveSecret('providers', 'openai', 'sk-test-123')
    expect(saved.ok).toBe(true)
    expect(readAuth().providers.openai).toBe('sk-test-123')

    const removed = removeSecret('providers', 'openai')
    expect(removed.ok).toBe(true)
    expect(readAuth().providers.openai).toBeUndefined()
  })

  it('creates, updates, disambiguates, and validates custom providers', () => {
    writeBaseConfig()

    const created = saveCustomProvider({
      name: 'Together AI',
      baseURL: 'https://api.together.xyz/v1/',
      wire: 'openai',
      apiKey: 'tok-1',
    })
    expect(created).toEqual({
      ok: true,
      value: {
        id: 'together-ai',
        created: true,
        entry: {
          name: 'Together AI',
          baseURL: 'https://api.together.xyz/v1',
          wire: 'openai',
        },
      },
    })
    expect(readConfig()?.providers['together-ai']).toEqual({
      name: 'Together AI',
      baseURL: 'https://api.together.xyz/v1',
      wire: 'openai',
    })
    expect(readAuth().providers['together-ai']).toBe('tok-1')

    // Disambiguates duplicate names when creating without an explicit id.
    const second = saveCustomProvider({
      name: 'Together AI',
      baseURL: 'http://127.0.0.1:8080/v1',
      wire: 'anthropic',
      keyless: true,
    })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.value.id).toBe('together-ai-2')
      expect(second.value.created).toBe(true)
      expect(second.value.entry.keyless).toBe(true)
    }

    // Updates an existing provider while preserving its stored key when omitted.
    const updated = saveCustomProvider({
      id: 'together-ai',
      name: 'Together Cloud',
      baseURL: 'https://api.together.xyz/v2',
      wire: 'responses',
    })
    expect(updated.ok).toBe(true)
    if (updated.ok) {
      expect(updated.value.created).toBe(false)
      expect(updated.value.entry.name).toBe('Together Cloud')
      expect(updated.value.entry.baseURL).toBe('https://api.together.xyz/v2')
      expect(updated.value.entry.wire).toBe('responses')
    }
    expect(readAuth().providers['together-ai']).toBe('tok-1')

    // Replaces the stored key when a new one is given.
    const rotated = saveCustomProvider({
      id: 'together-ai',
      name: 'Together Cloud',
      baseURL: 'https://api.together.xyz/v2',
      wire: 'responses',
      apiKey: 'tok-2',
    })
    expect(rotated.ok).toBe(true)
    expect(readAuth().providers['together-ai']).toBe('tok-2')

    // Switching to keyless clears the stored key.
    const madeKeyless = saveCustomProvider({
      id: 'together-ai',
      name: 'Together Cloud',
      baseURL: 'https://api.together.xyz/v2',
      wire: 'responses',
      keyless: true,
    })
    expect(madeKeyless.ok).toBe(true)
    expect(readAuth().providers['together-ai']).toBeUndefined()

    // Rejects reserved ids and invalid URLs.
    expect(
      saveCustomProvider({ id: 'openai', name: 'Fake', baseURL: 'https://example.com', keyless: true }),
    ).toEqual({ ok: false, error: '"openai" is reserved for a built-in provider.' })
    expect(
      saveCustomProvider({ id: 'groq', name: 'Groq', baseURL: 'https://example.com', keyless: true }),
    ).toEqual({ ok: false, error: '"groq" is reserved for a built-in provider.' })
    expect(
      saveCustomProvider({ name: 'Bad', baseURL: 'ftp://example.com', keyless: true }),
    ).toEqual({ ok: false, error: 'Enter a valid http:// or https:// endpoint URL.' })
    expect(
      saveCustomProvider({ name: 'Missing Key', baseURL: 'https://example.com/v1' }),
    ).toEqual({ ok: false, error: 'Enter an API key, or turn on "No API key required".' })
  })

  it('removes an inactive custom provider and refuses built-in or active ones', () => {
    writeBaseConfig()
    saveCustomProvider({
      name: 'My Proxy',
      baseURL: 'https://proxy.example/v1',
      wire: 'openai',
      apiKey: 'secret-proxy',
    })

    expect(removeCustomProvider('openai')).toEqual({
      ok: false,
      error: 'Built-in providers cannot be removed.',
    })
    expect(removeCustomProvider('test')).toEqual({
      ok: false,
      error: 'Switch to another provider before removing this one.',
    })

    const removed = removeCustomProvider('my-proxy')
    expect(removed).toEqual({ ok: true, value: { id: 'my-proxy' } })
    expect(readConfig()?.providers['my-proxy']).toBeUndefined()
    expect(readAuth().providers['my-proxy']).toBeUndefined()
  })
})
