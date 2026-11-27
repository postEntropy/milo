import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

const home = mkdtempSync(path.join(os.tmpdir(), 'milo-settings-tool-'))
process.env.MILO_HOME = home

const { settingsTool } = await import('../src/core/tools/settings.js')
const { readConfig } = await import('../src/core/config/load.js')

function writeBaseConfig(): void {
  writeFileSync(
    path.join(home, 'config.yml'),
    stringify({
      provider: 'test',
      model: 'test-model',
      providers: {
        test: {
          name: 'Test',
          baseURL: 'https://provider.example/v1',
          headers: { Authorization: 'secret-header' },
        },
      },
      permissions: { mode: 'ask', allow: ['read_file'], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
    }),
  )
}

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
})

describe('settings tool', () => {
  it('reads sanitized config and individual sections without exposing provider headers', async () => {
    writeBaseConfig()

    const full = await settingsTool.execute(
      { action: 'get' },
      { cwd: home, signal: new AbortController().signal },
    )
    expect(full.isError).toBeUndefined()
    expect(full.content).toContain('"provider": "test"')
    expect(full.content).not.toContain('secret-header')

    const section = await settingsTool.execute(
      { action: 'get', section: 'display' },
      { cwd: home, signal: new AbortController().signal },
    )
    expect(section.isError).toBeUndefined()
    expect(section.content).toContain('"tools": "full"')

    const unknown = await settingsTool.execute(
      { action: 'get', section: 'bogus' },
      { cwd: home, signal: new AbortController().signal },
    )
    expect(unknown.isError).toBe(true)
    expect(unknown.content).toContain('Valid sections:')
  })

  it('merges nested patches, clears optional keys with null, applies live updates, and reports restart requirements', async () => {
    writeBaseConfig()
    let appliedCount = 0
    const settingsAdmin = {
      apply: () => {
        appliedCount += 1
      },
    }

    const updated = await settingsTool.execute(
      {
        action: 'set',
        patch: {
          display: { thinking: 'collapsed' },
          permissions: { mode: 'auto' },
          reasoningEffort: 'high',
          search: { provider: 'tavily' },
        },
      },
      { cwd: home, signal: new AbortController().signal, settingsAdmin },
    )
    expect(updated.isError).toBeUndefined()
    expect(appliedCount).toBe(1)
    expect(updated.content).toContain('Updated settings: display.thinking, permissions.mode, reasoningEffort, search.provider.')
    expect(updated.content).toContain('Restart Milo to apply: Web search.')
    expect(readConfig()?.display).toEqual({ tools: 'full', thinking: 'collapsed' })
    expect(readConfig()?.permissions.allow).toEqual(['read_file'])
    expect(readConfig()?.permissions.mode).toBe('auto')
    expect(readConfig()?.reasoningEffort).toBe('high')
    expect(readConfig()?.search).toEqual({ provider: 'tavily' })

    const cleared = await settingsTool.execute(
      { action: 'set', patch: { search: null } },
      { cwd: home, signal: new AbortController().signal, settingsAdmin },
    )
    expect(cleared.isError).toBeUndefined()
    expect(readConfig()?.search).toBeUndefined()

    const restartable = await settingsTool.execute(
      { action: 'set', patch: { browser: { enabled: true }, verification: { enabled: true } } },
      { cwd: home, signal: new AbortController().signal, settingsAdmin },
    )
    expect(restartable.isError).toBeUndefined()
    expect(restartable.content).toContain('Restart Milo to apply: Browser, Verification gate.')
  })

  it('validates invalid values and routes provider edits to the providers tool', async () => {
    writeBaseConfig()

    const providerAttempt = await settingsTool.execute(
      { action: 'set', patch: { provider: 'openai' } },
      { cwd: home, signal: new AbortController().signal },
    )
    expect(providerAttempt.isError).toBe(true)
    expect(providerAttempt.content).toContain('providers tool')

    const badPalette = await settingsTool.execute(
      { action: 'set', patch: { palette: { palette: 'not-a-color' } } },
      { cwd: home, signal: new AbortController().signal },
    )
    expect(badPalette.isError).toBe(true)
    expect(badPalette.content).toContain('Unknown colour palette')
  })
})
