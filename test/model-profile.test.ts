import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  catalogEntry,
  lookupModelProfile,
  mergeModelProfile,
  rememberOutputCap,
} from '../src/core/providers/profile.js'

/** Shaped like the OpenRouter catalog: one entry per model, window included. */
const catalog = {
  data: [
    { id: 'deepseek/deepseek-v4.1-flash', context_length: 1048576, max_completion_tokens: 8192 },
    { id: 'openai/gpt-x', context_window: 128000, supports_reasoning: true },
    {
      id: 'anthropic/claude-y',
      max_context_tokens: 200000,
      architecture: { input_modalities: ['text', 'image', 'audio'] },
    },
    { id: 'no-window-model' },
  ],
}

const cacheFile = (): string =>
  path.join(mkdtempSync(path.join(tmpdir(), 'milo-models-')), 'models.json')

describe('catalogEntry', () => {
  it('finds the entry by exact id', () => {
    expect(catalogEntry(catalog, 'deepseek/deepseek-v4.1-flash')?.context).toBe(1048576)
  })

  it('accepts the id without its provider prefix', () => {
    // The same model is spelled with and without the vendor, depending on who
    // is asking.
    expect(catalogEntry(catalog, 'deepseek-v4.1-flash')?.context).toBe(1048576)
    expect(catalogEntry(catalog, 'claude-y')?.context).toBe(200000)
  })

  it('reads the field each catalog spells its own way', () => {
    expect(catalogEntry(catalog, 'openai/gpt-x')?.context).toBe(128000)
    expect(catalogEntry(catalog, 'anthropic/claude-y')?.context).toBe(200000)
  })

  it('reads the output ceiling, the inputs and whether it reasons', () => {
    expect(catalogEntry(catalog, 'deepseek-v4.1-flash')?.maxOutput).toBe(8192)
    expect(catalogEntry(catalog, 'openai/gpt-x')?.reasoning).toBe(true)
    expect(catalogEntry(catalog, 'anthropic/claude-y')).toMatchObject({ vision: true, audio: true })
  })

  it('returns nothing when there is no entry for it', () => {
    expect(catalogEntry(catalog, 'no-window-model')?.context).toBeUndefined()
    expect(catalogEntry(catalog, 'nope')).toBeUndefined()
    expect(catalogEntry({}, 'anything')).toBeUndefined()
    expect(catalogEntry(null, 'anything')).toBeUndefined()
  })
})

describe('mergeModelProfile', () => {
  it("lets the person's word outrank the provider and the public catalog", () => {
    const profile = mergeModelProfile('m', {
      override: { context: 1000, maxOutput: 100, vision: false },
      provider: { id: 'm', context: 2000, maxOutput: 200, vision: true },
      openRouter: { context: 3000, maxOutput: 300, vision: true },
    })

    expect(profile).toMatchObject({ context: 1000, maxOutput: 100, vision: false })
  })

  it("lets the provider's catalog outrank the public one", () => {
    const profile = mergeModelProfile('m', {
      provider: { id: 'm', context: 2000, maxOutput: 200 },
      openRouter: { context: 3000, maxOutput: 300 },
    })

    expect(profile).toMatchObject({ context: 2000, maxOutput: 200 })
  })

  it('reads a modality list as vision and audio', () => {
    const profile = mergeModelProfile('m', {
      provider: { id: 'm', inputModalities: ['image'] },
    })

    expect(profile).toMatchObject({ vision: true, audio: false })
  })

  it('leaves fields nobody answered absent, rather than guessing a zero', () => {
    expect(mergeModelProfile('m', {})).toEqual({ id: 'm' })
  })
})

describe('lookupModelProfile', () => {
  it('remembers the answer, so the catalog is read once', async () => {
    const file = cacheFile()
    let fetches = 0
    const fetchCatalog = async () => {
      fetches += 1
      return catalog
    }

    expect((await lookupModelProfile('openai/gpt-x', { file, fetchCatalog })).context).toBe(128000)
    expect((await lookupModelProfile('openai/gpt-x', { file, fetchCatalog })).context).toBe(128000)
    expect(fetches).toBe(1)
    expect(JSON.parse(readFileSync(file, 'utf8'))['openai/gpt-x'].profile.context).toBe(128000)
  })

  it('remembers that it did not know, rather than asking every run', async () => {
    const file = cacheFile()
    let fetches = 0
    const fetchCatalog = async () => {
      fetches += 1
      return catalog
    }

    expect((await lookupModelProfile('mystery-model', { file, fetchCatalog })).context).toBeUndefined()
    expect((await lookupModelProfile('mystery-model', { file, fetchCatalog })).context).toBeUndefined()
    expect(fetches).toBe(1)
  })

  it('applies a config change over an answer already cached', async () => {
    const file = cacheFile()
    const fetchCatalog = async () => catalog

    expect((await lookupModelProfile('openai/gpt-x', { file, fetchCatalog, override: { context: 1000 } })).context).toBe(1000)
    // The catalog's own answer stays in the cache; the new word wins now, and
    // removing the override brings the catalog's answer back.
    expect((await lookupModelProfile('openai/gpt-x', { file, fetchCatalog, override: { context: 2000 } })).context).toBe(2000)
    expect((await lookupModelProfile('openai/gpt-x', { file, fetchCatalog })).context).toBe(128000)
  })

  it('asks again once the answer is old', async () => {
    const file = cacheFile()
    let fetches = 0
    const fetchCatalog = async () => {
      fetches += 1
      return catalog
    }
    const day = 24 * 60 * 60 * 1000

    await lookupModelProfile('openai/gpt-x', { file, fetchCatalog, now: () => 0 })
    await lookupModelProfile('openai/gpt-x', { file, fetchCatalog, now: () => 8 * day })

    expect(fetches).toBe(2)
  })

  it('merges the provider catalog and the config, and never throws when one fails', async () => {
    const file = cacheFile()
    const profile = await lookupModelProfile('m', {
      file,
      override: { maxOutput: 64 },
      fetchProvider: async () => [{ id: 'm', context: 4096, reasoning: false }],
      fetchCatalog: async () => {
        throw new Error('offline')
      },
    })

    expect(profile).toMatchObject({ context: 4096, maxOutput: 64, reasoning: false })
  })
})

describe('rememberOutputCap', () => {
  /** The provider's own catalog declaring a ceiling the route refuses — the shape seen by hand. */
  const lying = {
    data: [{ id: 'deepseek/deepseek-v4.1-flash', context_length: 1048576, max_completion_tokens: 943_718 }],
  }
  const model = 'deepseek/deepseek-v4.1-flash'
  const day = 24 * 60 * 60 * 1000

  it('keeps the ceiling a route named, across a catalog read that still says otherwise', async () => {
    const file = cacheFile()
    const fetchCatalog = async () => lying

    expect((await lookupModelProfile(model, { file, fetchCatalog, now: () => 0 })).maxOutput).toBe(943_718)
    await rememberOutputCap(model, 393_216, { file })

    // A week later the catalogs are asked again, and claim the larger number again.
    const profile = await lookupModelProfile(model, { file, fetchCatalog, now: () => 8 * day })
    expect(profile.maxOutput).toBe(393_216)
  })

  it('never raises a ceiling a catalog states lower', async () => {
    const file = cacheFile()
    await rememberOutputCap(model, 393_216, { file })

    // This catalog says 8192 for the same model: the smaller number is the real one.
    expect((await lookupModelProfile(model, { file, fetchCatalog: async () => catalog })).maxOutput).toBe(8192)
  })

  it("still lets the person's own ceiling win", async () => {
    const file = cacheFile()
    await rememberOutputCap(model, 393_216, { file })

    const profile = await lookupModelProfile(model, {
      file,
      fetchCatalog: async () => catalog,
      override: { maxOutput: 64 },
    })
    expect(profile.maxOutput).toBe(64)
  })
})
