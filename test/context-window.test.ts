import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lookupContextWindow, windowFrom } from '../src/core/providers/context.js'

/** Shaped like the OpenRouter catalog: one entry per model, window included. */
const catalog = {
  data: [
    { id: 'deepseek/deepseek-v4.1-flash', context_length: 1048576 },
    { id: 'openai/gpt-x', context_window: 128000 },
    { id: 'anthropic/claude-y', max_context_tokens: 200000 },
    { id: 'no-window-model' },
  ],
}

const cacheFile = (): string =>
  path.join(mkdtempSync(path.join(tmpdir(), 'milo-ctx-')), 'context-windows.json')

describe('windowFrom', () => {
  it('finds the window by exact id', () => {
    expect(windowFrom(catalog, 'deepseek/deepseek-v4.1-flash')).toBe(1048576)
  })

  it('accepts the id without its provider prefix', () => {
    // The same model is spelled with and without the vendor, depending on who
    // is asking.
    expect(windowFrom(catalog, 'deepseek-v4.1-flash')).toBe(1048576)
    expect(windowFrom(catalog, 'claude-y')).toBe(200000)
  })

  it('reads the field each catalog spells its own way', () => {
    expect(windowFrom(catalog, 'openai/gpt-x')).toBe(128000)
    expect(windowFrom(catalog, 'anthropic/claude-y')).toBe(200000)
  })

  it('returns null when there is no window for it', () => {
    expect(windowFrom(catalog, 'no-window-model')).toBeNull()
    expect(windowFrom(catalog, 'nope')).toBeNull()
    expect(windowFrom({}, 'anything')).toBeNull()
    expect(windowFrom(null, 'anything')).toBeNull()
  })
})

describe('lookupContextWindow', () => {
  it('remembers the answer, so the catalog is read once', async () => {
    const file = cacheFile()
    let fetches = 0
    const fetchCatalog = async () => {
      fetches += 1
      return catalog
    }

    expect(await lookupContextWindow('openai/gpt-x', { file, fetchCatalog })).toBe(128000)
    expect(await lookupContextWindow('openai/gpt-x', { file, fetchCatalog })).toBe(128000)
    expect(fetches).toBe(1)
    expect(JSON.parse(readFileSync(file, 'utf8'))['openai/gpt-x'].tokens).toBe(128000)
  })

  it('remembers that it did not know, rather than asking every run', async () => {
    const file = cacheFile()
    let fetches = 0
    const fetchCatalog = async () => {
      fetches += 1
      return catalog
    }

    expect(await lookupContextWindow('mystery-model', { file, fetchCatalog })).toBeUndefined()
    expect(await lookupContextWindow('mystery-model', { file, fetchCatalog })).toBeUndefined()
    expect(fetches).toBe(1)
  })

  it('asks again once the answer is old', async () => {
    const file = cacheFile()
    let fetches = 0
    const fetchCatalog = async () => {
      fetches += 1
      return catalog
    }
    const day = 24 * 60 * 60 * 1000

    await lookupContextWindow('openai/gpt-x', { file, fetchCatalog, now: () => 0 })
    await lookupContextWindow('openai/gpt-x', { file, fetchCatalog, now: () => 8 * day })

    expect(fetches).toBe(2)
  })

  it('never throws when the catalog cannot be read', async () => {
    const file = cacheFile()
    const fetchCatalog = async () => {
      throw new Error('offline')
    }

    expect(await lookupContextWindow('openai/gpt-x', { file, fetchCatalog })).toBeUndefined()
  })
})
