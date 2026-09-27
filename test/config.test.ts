import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-config-'))
process.env.MILO_HOME = home

const { readConfig, readDisplay, saveConfig, setDisplay, setPermissionMode } = await import(
  '../src/core/config/load.js'
)
const { ConfigSchema } = await import('../src/core/config/schema.js')

const configFile = path.join(home, 'config.yml')

const base = {
  provider: 'commandcode',
  model: 'some-model',
  providers: { commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' } },
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
  writeFileSync(configFile, stringify(base))
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
      stringify({ ...base, display: { tools: 'name', thinking: false } }),
    )
    expect(readDisplay()).toEqual({ tools: 'name', thinking: 'off' })

    for (const before of [true, 'brief', 'full']) {
      writeFileSync(configFile, stringify({ ...base, display: { tools: 'full', thinking: before } }))
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

describe('the config as YAML', () => {
  it('explains itself, because every surface rewrites it', () => {
    rmSync(configFile, { force: true })
    saveConfig(ConfigSchema.parse(base))

    // A comment that only lived in the file would be gone by the next `/mode`, so
    // the help is written by the code that writes the file.
    const text = readFileSync(configFile, 'utf8')
    expect(text).toContain('# Which provider this install talks to')
    expect(text).toContain('# How many sessions stay on disk. 0 keeps every one.')
    // An empty section is still written, or the file would lose the one place the
    // bot surfaces are turned on.
    expect(text).toContain('gateways: {}')
    expect(readConfig()?.provider).toBe('commandcode')
  })

  it('leaves a blank line between the top-level blocks, and only one', () => {
    rmSync(configFile, { force: true })
    saveConfig(ConfigSchema.parse(base))

    let text = readFileSync(configFile, 'utf8')
    // The comment opens the section it explains, so the separator goes above it.
    expect(text).toContain('\n\n# One entry per provider')
    // The file does not open on a blank line — there is nothing to separate from.
    expect(text.startsWith('# Which provider')).toBe(true)

    // A later save rewrites every line, so the flag must not stack up one more
    // blank line per save.
    setDisplay({ tools: 'name' })
    text = readFileSync(configFile, 'utf8')
    expect(text).not.toContain('\n\n\n')
    expect(text.match(/\n\n# One entry per provider/g)).toHaveLength(1)
  })

  it('keeps a comment the file was written with, through a save', () => {
    writeFileSync(
      configFile,
      stringify(base).replace(/^provider:/m, '# mine, keep it\nprovider:'),
    )

    setDisplay({ tools: 'name' })

    const text = readFileSync(configFile, 'utf8')
    expect(text).toContain('# mine, keep it')
    expect(readConfig()?.display.tools).toBe('name')
    // And the help is stamped alongside it, not instead of it.
    expect(text).toContain('# How much of a turn the surfaces show')
  })

  it('does not stamp the help a second time on a later save', () => {
    rmSync(configFile, { force: true })
    saveConfig(ConfigSchema.parse(base))

    // The comment before a block's first key comes back from the parser attached
    // to the collection above it rather than to the key, so a save that looked for
    // it on the key would miss it and add another copy — one per save, forever.
    setDisplay({ tools: 'name' })

    const text = readFileSync(configFile, 'utf8')
    expect(text.match(/# How many sessions stay on disk/g)).toHaveLength(1)
    expect(text.match(/# How much of a turn the surfaces show/g)).toHaveLength(1)
    expect(readConfig()?.display.tools).toBe('name')
  })
})
