import { describe, expect, it } from 'vitest'
import { DefaultPermissionPolicy } from '../src/core/tools/permission'
import { decodePermission, encodePermission, handleCommand, modeLockMessage } from '../src/gateways/commands'
import { PendingDecisions } from '../src/gateways/pending'

describe('handleCommand', () => {
  it('ignores normal messages', () => {
    expect(handleCommand('hello there', {}).handled).toBe(false)
  })

  it('lists the commands', () => {
    const result = handleCommand('/help', {})
    expect(result.handled).toBe(true)
    expect(result.reply).toContain('/mode')
  })

  it('treats /start as help (Telegram suggests it)', () => {
    expect(handleCommand('/start', {}).reply).toContain('/mode')
  })

  it('sets the permission mode and writes it down', () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []
    const result = handleCommand('/mode auto', {
      policy,
      persistMode: (mode) => saved.push(mode),
    })

    expect(result.reply).toContain('auto')
    expect(policy.mode).toBe('auto')
    expect(saved).toEqual(['auto'])
  })

  it('reports the current mode for a bad argument', () => {
    const policy = new DefaultPermissionPolicy({ mode: 'yolo' })
    const result = handleCommand('/mode nonsense', { policy })
    expect(result.reply).toContain('yolo')
    expect(policy.mode).toBe('yolo')
  })

  it('toggles yolo and writes it down', () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []

    handleCommand('/yolo', { policy, persistMode: (mode) => saved.push(mode) })
    expect(policy.mode).toBe('yolo')

    handleCommand('/yolo', { policy, persistMode: (mode) => saved.push(mode) })
    expect(policy.mode).toBe('ask')
    expect(saved).toEqual(['yolo', 'ask'])
  })

  it('refuses to change the mode when the surface is locked', () => {
    const policy = new DefaultPermissionPolicy()
    const saved: string[] = []
    const context = { policy, persistMode: (mode: string) => saved.push(mode), modeLocked: '🔒 locked' }

    expect(handleCommand('/mode yolo', context).reply).toBe('🔒 locked')
    expect(handleCommand('/yolo', context).reply).toBe('🔒 locked')
    expect(policy.mode).toBe('ask')
    expect(saved).toEqual([])
  })

  it('clears the session', () => {
    let cleared = false
    const result = handleCommand('/clear', { resetSession: () => { cleared = true } })
    expect(cleared).toBe(true)
    expect(result.reply).toContain('cleared')
  })

  it('points /setup and /model at the terminal', () => {
    expect(handleCommand('/setup', {}).reply).toContain('milo setup')
    expect(handleCommand('/model', {}).reply).toContain('milo setup')
  })

  it('rejects unknown commands', () => {
    expect(handleCommand('/nope', {}).reply).toContain('Unknown command')
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
