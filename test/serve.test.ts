import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-serve-'))
process.env.MILO_HOME = home

const calls = vi.hoisted(() => ({ started: [] as string[] }))

vi.mock('../src/gateways/telegram/index.js', () => ({
  TelegramGateway: class {
    id = 'telegram'
    async start() {
      calls.started.push('telegram')
    }
    async stop() {}
  },
}))

vi.mock('../src/gateways/discord/index.js', () => ({
  DiscordGateway: class {
    id = 'discord'
    async start() {
      calls.started.push('discord')
    }
    async stop() {}
  },
}))

const { runServe } = await import('../src/gateways/serve.js')

const configWith = (gateways: Record<string, { enabled: boolean; allowlist: string[] }>) =>
  JSON.stringify(
    {
      provider: 'test',
      model: 'test-model',
      providers: { test: { baseURL: 'https://x.test/v1', wire: 'openai' } },
      display: { tools: 'full', thinking: 'on' },
      gateways,
      permissions: { mode: 'ask', allow: [], deny: [], jevThreshold: 0.35, jevTimeoutMs: 1500 },
    },
    null,
    2,
  )

const messages: string[] = []
const originalExitCode = process.exitCode

describe('runServe', () => {
  beforeEach(() => {
    calls.started = []
    messages.length = 0
    process.exitCode = 0
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    rmSync(path.join(home, 'config.json'), { force: true })
    rmSync(path.join(home, 'auth.json'), { force: true })
    // Startup creates this one, so a skill left behind by a test would be read
    // by the next.
    rmSync(path.join(home, 'skills'), { recursive: true, force: true })
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      messages.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = originalExitCode
  })

  it('refuses to serve without a configuration', async () => {
    await runServe()

    expect(process.exitCode).toBe(1)
    expect(messages.join('\n')).toContain('No configuration found')
  })

  it('starts the enabled gateways and says which', async () => {
    writeFileSync(
      path.join(home, 'config.json'),
      configWith({
        telegram: { enabled: true, allowlist: [] },
        discord: { enabled: true, allowlist: [] },
      }),
    )
    process.env.TELEGRAM_BOT_TOKEN = 'tg-token'
    process.env.DISCORD_BOT_TOKEN = 'dc-token'

    await runServe()

    expect(calls.started).toEqual(['telegram', 'discord'])
    expect(messages.join('\n')).toContain('Milo serving: telegram, discord')
    expect(process.exitCode).toBe(0)
  })

  it('says what it is running with, and how many skills it read', async () => {
    writeFileSync(
      path.join(home, 'config.json'),
      configWith({ telegram: { enabled: true, allowlist: [] } }),
    )
    process.env.TELEGRAM_BOT_TOKEN = 'tg-token'
    const dir = path.join(home, 'skills', 'deploy')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: deploy\ndescription: How to deploy\n---\n\nRun it.\n',
    )

    await runServe()

    // The count is the only way to tell whether the startup index saw the
    // skills, since nothing else about them is printed.
    const output = messages.join('\n')
    expect(output).toContain('test-model (test)')
    expect(output).toContain('mode ask')
    expect(output).toContain('1 skill')
    expect(output).toContain(home)
  })

  it('says the token is missing and starts nothing', async () => {
    writeFileSync(
      path.join(home, 'config.json'),
      configWith({ telegram: { enabled: true, allowlist: [] } }),
    )

    await runServe()

    expect(calls.started).toEqual([])
    expect(process.exitCode).toBe(1)
    const output = messages.join('\n')
    expect(output).toContain('Telegram is enabled but no token was found (TELEGRAM_BOT_TOKEN).')
    expect(output).toContain('No gateways enabled')
  })
})
