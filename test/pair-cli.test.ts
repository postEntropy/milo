import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { stringify } from 'yaml'

// Both verbs read and write under `~/.milo`, so a throwaway home is the whole
// point — a test that pairs is a test that writes a registry.
const home = mkdtempSync(path.join(tmpdir(), 'milo-pair-cli-'))
process.env.MILO_HOME = home

const { runPair, preferTailnet } = await import('../src/bin/pair.js')
const { runDevices } = await import('../src/bin/devices.js')
const { addDevice } = await import('../src/gateways/web/devices.js')
const { currentPairing } = await import('../src/gateways/web/pair.js')

const configWith = (web: Record<string, unknown>): string =>
  stringify({
    provider: 'test',
    model: 'test-model',
    providers: { test: { baseURL: 'https://x.test/v1', wire: 'openai' } },
    web,
  })

function collect(): { io: { out(line: string): void; err(line: string): void }; lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return { io: { out: (line) => lines.push(line), err: (line) => errors.push(line) }, lines, errors }
}

beforeEach(() => {
  rmSync(path.join(home, 'pairing.json'), { force: true })
  rmSync(path.join(home, 'devices.json'), { force: true })
})

describe('milo pair', () => {
  it('opens a code and prints it with the address to give the app', async () => {
    // A fixed bind, so the printed address is the one the config named rather
    // than whatever this machine's interfaces happen to be.
    writeFileSync(path.join(home, 'config.yml'), configWith({ host: '192.168.1.50', port: 8123 }))
    const { io, lines } = collect()

    expect(await runPair([], io)).toBe(0)
    const open = currentPairing()
    if (!open) throw new Error('no code was opened')
    const output = lines.join('\n')
    expect(output).toContain('192.168.1.50:8123')
    expect(output).toContain(`${open.code.slice(0, 3)} ${open.code.slice(3)}`)
  })

  it('says a loopback bind reaches no phone, rather than promising one', async () => {
    writeFileSync(path.join(home, 'config.yml'), configWith({ host: '127.0.0.1', port: 7717 }))
    const { io, lines } = collect()

    await runPair([], io)
    expect(lines.join('\n')).toContain('only a loopback address')
  })

  it('answers an argument it does not know with the ones it does', async () => {
    const { io, errors } = collect()
    expect(await runPair(['frobnicate'], io)).toBe(1)
    expect(errors.join('\n')).toContain('Unknown: milo pair frobnicate')
    expect(errors.join('\n')).toContain('Usage:')
  })

  it('offers a tailnet address before a plain LAN one, because that is the one a phone can reach', () => {
    // The trap this exists for: the LAN name is the obvious one to pick and the
    // one a host firewall is most likely to have shut.
    expect(preferTailnet(['192.168.100.100', '100.119.178.78'])).toEqual(['100.119.178.78', '192.168.100.100'])
    expect(preferTailnet(['192.168.1.5'])).toEqual(['192.168.1.5'])
    // Outside the CGNAT block it is not a tailnet address, and is not promoted.
    expect(preferTailnet(['100.200.0.1', '10.0.0.5'])).toEqual(['100.200.0.1', '10.0.0.5'])
  })
})

describe('milo devices', () => {
  it('says plainly that nothing is paired', async () => {
    const { io, lines } = collect()
    expect(await runDevices([], io)).toBe(0)
    expect(lines.join('\n')).toContain('No devices are paired')
  })

  it('lists a paired device, and forgets it by the id it printed', async () => {
    const { device } = addDevice({ name: 'iPhone', platform: 'ios' })

    const listed = collect()
    await runDevices([], listed.io)
    expect(listed.lines.join('\n')).toContain('iPhone')

    const revoked = collect()
    expect(await runDevices(['revoke', device.id.slice(0, 8)], revoked.io)).toBe(0)
    expect(revoked.lines.join('\n')).toContain('Revoked iPhone')

    const after = collect()
    await runDevices([], after.io)
    expect(after.lines.join('\n')).toContain('No devices are paired')
  })

  it('refuses a name it cannot place, and a word it does not know', async () => {
    const unknown = collect()
    expect(await runDevices(['revoke', 'nope'], unknown.io)).toBe(1)
    expect(unknown.errors.join('\n')).toContain('No paired device matches')

    const bad = collect()
    expect(await runDevices(['frobnicate'], bad.io)).toBe(1)
    expect(bad.errors.join('\n')).toContain('Unknown: milo devices frobnicate')
  })
})
