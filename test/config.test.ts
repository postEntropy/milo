import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-config-'))
process.env.MILO_HOME = home

const { readConfig, readDisplay, setDisplay, setPermissionMode } = await import(
  '../src/core/config/load.js'
)

const configFile = path.join(home, 'config.json')

const base = {
  provider: 'commandcode',
  model: 'some-model',
  providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
  memory: { backend: 'file' as const },
  gateways: {},
  permissions: {
    mode: 'ask' as const,
    allow: ['shell_command'],
    deny: ['never'],
    jevThreshold: 0.35,
    jevTimeoutMs: 1500,
  },
}

beforeEach(() => {
  writeFileSync(configFile, JSON.stringify(base, null, 2))
})

afterEach(() => {
  rmSync(configFile, { force: true })
})

describe('setPermissionMode', () => {
  it('writes the mode and leaves the rest of the file alone', () => {
    setPermissionMode('yolo')

    const config = readConfig()
    expect(config?.permissions.mode).toBe('yolo')
    expect(config?.permissions.allow).toEqual(['shell_command'])
    expect(config?.permissions.deny).toEqual(['never'])
    expect(config?.permissions.jevThreshold).toBe(0.35)
    expect(config?.provider).toBe('commandcode')
  })

  it('does nothing when there is no config yet', () => {
    rmSync(configFile, { force: true })

    expect(() => setPermissionMode('auto')).not.toThrow()
    expect(existsSync(configFile)).toBe(false)
  })
})

describe('reasoning effort', () => {
  it('asks for medium when the file says nothing about it', () => {
    // Every request carries an explicit effort now: "let the provider and model
    // decide" was a value nobody could name, and `effort default` a label nobody
    // could read.
    expect(readConfig()?.reasoningEffort).toBe('medium')
  })
})

describe('display settings', () => {
  it('defaults to showing everything when the file predates them', () => {
    expect(readDisplay()).toEqual({ tools: 'full', thinking: 'on' })
  })

  it('reads the forms the setting used to have, so an old file still loads', () => {
    // A config written before the current form says `true`, `false`, `brief` or
    // `full`, and refusing one would fail the whole file and take every other
    // setting with it.
    writeFileSync(
      configFile,
      JSON.stringify({ ...base, display: { tools: 'name', thinking: false } }, null, 2),
    )
    expect(readDisplay()).toEqual({ tools: 'name', thinking: 'off' })

    for (const before of [true, 'brief', 'full']) {
      writeFileSync(
        configFile,
        JSON.stringify({ ...base, display: { tools: 'full', thinking: before } }, null, 2),
      )
      // Every one of them showed the reasoning, which is `on`.
      expect(readDisplay()).toEqual({ tools: 'full', thinking: 'on' })
    }
  })

  it('writes one setting and leaves the other alone', () => {
    setDisplay({ tools: 'off' })
    expect(readDisplay()).toEqual({ tools: 'off', thinking: 'on' })

    setDisplay({ thinking: 'off' })
    expect(readDisplay()).toEqual({ tools: 'off', thinking: 'off' })
    expect(readConfig()?.display).toEqual({ tools: 'off', thinking: 'off' })
  })

  it('falls back to the defaults on an unreadable file rather than throwing', () => {
    writeFileSync(configFile, '{ not json')

    expect(() => readDisplay()).not.toThrow()
    expect(readDisplay()).toEqual({ tools: 'full', thinking: 'on' })
  })

  it('does not throw away a change just because the file is unreadable', () => {
    writeFileSync(configFile, '{ not json')

    // The turn in progress must not end because one setting could not be saved.
    expect(() => setDisplay({ tools: 'off' })).not.toThrow()
    expect(() => setPermissionMode('yolo')).not.toThrow()
    expect(readDisplay()).toEqual({ tools: 'full', thinking: 'on' })
  })
})
