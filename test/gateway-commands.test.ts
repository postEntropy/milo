import { describe, expect, it } from 'vitest'
import type { DisplayConfig } from '../src/core/config/schema'
import { DefaultPermissionPolicy } from '../src/core/tools/permission'
import {
  decodePermission,
  encodePermission,
  handleCommand,
  modeLockMessage,
  sessionLockMessage,
} from '../src/gateways/commands'
import { PendingDecisions } from '../src/gateways/pending'

describe('handleCommand', () => {
  it('ignores normal messages', async () => {
    expect((await handleCommand('hello there', {})).handled).toBe(false)
  })

  it('lists the commands', async () => {
    const result = await handleCommand('/help', {})
    expect(result.handled).toBe(true)
    expect(result.reply).toContain('/mode')
    expect(result.reply).toContain('/sessions')
  })

  it('treats /start as help (Telegram suggests it)', async () => {
    expect((await handleCommand('/start', {})).reply).toContain('/mode')
  })

  it('sets the permission mode and writes it down', async () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []
    const result = await handleCommand('/mode auto', {
      policy,
      persistMode: (mode) => saved.push(mode),
    })

    expect(result.reply).toContain('auto')
    expect(policy.mode).toBe('auto')
    expect(saved).toEqual(['auto'])
  })

  it('reports the current mode for a bad argument', async () => {
    const policy = new DefaultPermissionPolicy({ mode: 'yolo' })
    const result = await handleCommand('/mode nonsense', { policy })
    expect(result.reply).toContain('yolo')
    expect(policy.mode).toBe('yolo')
  })

  it('toggles yolo and writes it down', async () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []

    await handleCommand('/yolo', { policy, persistMode: (mode) => saved.push(mode) })
    expect(policy.mode).toBe('yolo')

    await handleCommand('/yolo', { policy, persistMode: (mode) => saved.push(mode) })
    expect(policy.mode).toBe('ask')
    expect(saved).toEqual(['yolo', 'ask'])
  })

  it('refuses to change the mode when the surface is locked', async () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []
    const context = { policy, persistMode: (mode: string) => saved.push(mode), modeLocked: '🔒 locked' }

    expect((await handleCommand('/mode yolo', context)).reply).toBe('🔒 locked')
    expect((await handleCommand('/yolo', context)).reply).toBe('🔒 locked')
    expect(policy.mode).toBe('ask')
    expect(saved).toEqual([])
  })

  it('clears the session', async () => {
    let cleared = false
    const result = await handleCommand('/clear', {
      resetSession: () => {
        cleared = true
      },
    })
    expect(cleared).toBe(true)
    expect(result.reply).toContain('cleared')
  })

  it('starts a new session with an optional title', async () => {
    const titles: (string | undefined)[] = []
    const result = await handleCommand('/new my project', {
      newSession: async (title) => {
        titles.push(title)
        return { id: 'calm-otter-7' }
      },
    })

    expect(titles).toEqual(['my project'])
    expect(result.reply).toContain('calm-otter-7')
  })

  it('lists saved sessions', async () => {
    const session = {
      id: 'calm-otter-7',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 2,
      preview: 'hi',
    }
    const result = await handleCommand('/sessions', { listSessions: async () => [session] })
    expect(result.reply).toContain('calm-otter-7')
  })

  it('offers a Markdown rendering of the session list', async () => {
    const result = await handleCommand('/sessions', {
      listSessions: async () => [
        {
          id: 'calm-otter-7',
          title: 'my project',
          createdAt: 0,
          updatedAt: 0,
          messageCount: 2,
          preview: 'hi',
        },
      ],
    })

    expect(result.markdown).toContain('**calm-otter-7 — my project**')
    // The plain rendering stays free of Markdown for the CLI.
    expect(result.reply).not.toContain('**')
  })

  it('resumes a session and reports unknown ids', async () => {
    let used = ''
    const ok = await handleCommand('/resume calm-otter-7', {
      resumeSession: async (id) => {
        used = id
        return true
      },
    })
    expect(used).toBe('calm-otter-7')
    expect(ok.reply).toContain('Switched to session calm-otter-7')

    const missing = await handleCommand('/resume nope-nope-1', {
      resumeSession: async () => false,
    })
    expect(missing.reply).toContain('No session')

    const noArg = await handleCommand('/resume', { resumeSession: async () => true })
    expect(noArg.reply).toContain('Usage: /resume')
  })

  it('shows the current session stats', async () => {
    const result = await handleCommand('/stats', {
      sessionStats: () => ({
        id: 'calm-otter-7',
        createdAt: 0,
        updatedAt: 0,
        messages: 4,
        turns: 2,
        tokens: 100,
        compacted: false,
      }),
    })
    expect(result.reply).toContain('calm-otter-7')
    expect(result.reply).toContain('2 turns')
    expect(result.reply).toContain('~100 tokens')
    expect(result.reply).not.toContain('compacted')
  })

  it('locks session commands on a shared or open bot', async () => {
    const context = { sessionLocked: '🔒 locked' }
    expect((await handleCommand('/new', context)).reply).toBe('🔒 locked')
    expect((await handleCommand('/sessions', context)).reply).toBe('🔒 locked')
    expect((await handleCommand('/resume x-y-1', context)).reply).toBe('🔒 locked')
  })

  it('points /setup and /model at the terminal', async () => {
    expect((await handleCommand('/setup', {})).reply).toContain('milo setup')
    expect((await handleCommand('/model', {})).reply).toContain('milo setup')
  })

  it('lists the display commands in help', async () => {
    const reply = (await handleCommand('/help', {})).reply ?? ''
    expect(reply).toContain('/tools full|name|off')
    expect(reply).toContain('/thinking on|off')
  })

  it('sets how much of a tool call to show, and writes it down', async () => {
    const saved: Partial<DisplayConfig>[] = []
    const result = await handleCommand('/tools name', {
      display: { tools: 'full', thinking: true },
      persistDisplay: (patch) => saved.push(patch),
    })

    expect(result.reply).toContain('Tools: name')
    expect(saved).toEqual([{ tools: 'name' }])
  })

  it('says a failure is still reported when tools are off', async () => {
    const result = await handleCommand('/tools off', {
      display: { tools: 'full', thinking: true },
      persistDisplay: () => {},
    })

    expect(result.reply).toContain('still reported')
  })

  it('reports the current level for a bad argument', async () => {
    const saved: Partial<DisplayConfig>[] = []
    const result = await handleCommand('/tools nonsense', {
      display: { tools: 'name', thinking: false },
      persistDisplay: (patch) => saved.push(patch),
    })

    expect(result.reply).toContain('Tools: name')
    expect(result.reply).toContain('/tools full|name|off')
    expect(saved).toEqual([])
  })

  it('toggles thinking with no argument and takes on/off', async () => {
    const saved: Partial<DisplayConfig>[] = []
    const context = {
      display: { tools: 'full' as const, thinking: true },
      persistDisplay: (patch: Partial<DisplayConfig>) => saved.push(patch),
    }

    await handleCommand('/thinking', context)
    await handleCommand('/thinking on', { ...context, display: { tools: 'full', thinking: false } })
    await handleCommand('/thinking off', context)

    expect(saved).toEqual([{ thinking: false }, { thinking: true }, { thinking: false }])
  })

  it('refuses display changes on a surface without them', async () => {
    expect((await handleCommand('/tools off', {})).reply).toContain('not available')
    expect((await handleCommand('/thinking off', {})).reply).toContain('not available')
  })

  it('reports display settings in /status', async () => {
    const reply = (await handleCommand('/status', { display: { tools: 'off', thinking: false } }))
      .reply
    expect(reply).toContain('Tools: off')
    expect(reply).toContain('thinking: off')
  })

  it('rejects unknown commands', async () => {
    expect((await handleCommand('/nope', {})).reply).toContain('Unknown command')
  })
})

describe('modeLockMessage', () => {
  it('leaves a single-person bot alone', () => {
    expect(modeLockMessage(['42'])).toBeUndefined()
  })

  it('locks a bot that answers anyone', () => {
    expect(modeLockMessage([])).toContain('anyone')
    expect(modeLockMessage(undefined)).toContain('anyone')
  })

  it('locks a shared bot and says how many', () => {
    expect(modeLockMessage(['42', '43'])).toContain('2 ids')
  })
})

describe('sessionLockMessage', () => {
  it('leaves a single-person bot alone', () => {
    expect(sessionLockMessage(['42'])).toBeUndefined()
  })

  it('locks a bot that answers anyone', () => {
    expect(sessionLockMessage([])).toContain('anyone')
    expect(sessionLockMessage(undefined)).toContain('anyone')
  })

  it('locks a shared bot and says how many', () => {
    expect(sessionLockMessage(['42', '43'])).toContain('2 ids')
  })
})

describe('permission callback payloads', () => {
  it('round-trips', () => {
    expect(decodePermission(encodePermission('abc', true))).toEqual({ id: 'abc', allowed: true })
    expect(decodePermission(encodePermission('abc', false))).toEqual({ id: 'abc', allowed: false })
  })

  it('rejects malformed data', () => {
    expect(decodePermission('nonsense')).toBeNull()
    expect(decodePermission('perm:abc:maybe')).toBeNull()
    expect(decodePermission('perm::allow')).toBeNull()
  })
})

describe('PendingDecisions', () => {
  it('resolves a waiting decision', async () => {
    const pending = new PendingDecisions()
    const waiting = pending.wait('id1', 1000)
    expect(pending.resolve('id1', true)).toBe(true)
    expect(await waiting).toBe(true)
    expect(pending.size).toBe(0)
  })

  it('returns false for unknown ids', () => {
    const pending = new PendingDecisions()
    expect(pending.resolve('nope', true)).toBe(false)
  })

  it('resolves false on expiry', async () => {
    const pending = new PendingDecisions()
    const waiting = pending.wait('id2', 20)
    expect(await waiting).toBe(false)
    expect(pending.size).toBe(0)
  })
})
