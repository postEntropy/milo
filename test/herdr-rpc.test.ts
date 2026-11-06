import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const { herdrCall, HerdrNotInstalled } = await import('../src/core/herdr-rpc.js')

type FakeChild = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function connection(reply: string, code = 0, closeOnInput = true) {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  let input = ''
  child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString() })
  child.stdin.on('finish', () => {
    if (reply) child.stdout.write(reply)
    if (closeOnInput) child.emit('close', code)
  })
  spawnMock.mockReturnValueOnce(child)
  return { input: () => input, child }
}

afterEach(() => {
  vi.useRealTimers()
  spawnMock.mockReset()
})

describe('Herdr JSON-RPC', () => {
  it('sends one line-framed request and returns its result', async () => {
    const fake = connection('{"jsonrpc":"2.0","id":1,"result":{"terminals":[]}}\n')
    expect(await herdrCall('terminal.list', { all: true })).toEqual({ terminals: [] })
    expect(spawnMock).toHaveBeenLastCalledWith('hc', ['connect'], { stdio: ['pipe', 'pipe', 'pipe'] })
    expect(JSON.parse(fake.input())).toEqual({ jsonrpc: '2.0', id: 1, method: 'terminal.list', params: { all: true } })
  })

  it('reports a standard error returned by Herdr', async () => {
    connection('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"no such terminal"}}\n')
    await expect(herdrCall('terminal.get', { terminal: 't1' })).rejects.toThrow('no such terminal')
  })

  it.each([
    ['missing version', '{"id":1,"result":null}'],
    ['wrong version', '{"jsonrpc":"1.0","id":1,"result":null}'],
    ['wrong id', '{"jsonrpc":"2.0","id":2,"result":null}'],
    ['no outcome', '{"jsonrpc":"2.0","id":1}'],
    ['both outcomes', '{"jsonrpc":"2.0","id":1,"result":null,"error":{"code":-1,"message":"failure"}}'],
    ['malformed error', '{"jsonrpc":"2.0","id":1,"error":{"message":"failure"}}'],
  ])('rejects %s', async (_name, response) => {
    connection(`${response}\n`)
    await expect(herdrCall('terminal.list', {})).rejects.toThrow('Herdr request failed')
  })

  it('preserves a valid null result', async () => {
    connection('{"jsonrpc":"2.0","id":1,"result":null}')
    await expect(herdrCall('terminal.keep', { terminal: 't1', keep: false })).resolves.toBeNull()
  })

  it('rejects malformed JSON', async () => {
    connection('not json')
    await expect(herdrCall('terminal.list', {})).rejects.toThrow('Herdr request failed')
  })

  it('distinguishes an absent hc executable', async () => {
    const fake = connection('', 0, false)
    const request = herdrCall('terminal.list', {})
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
    fake.child.emit('error', error)
    await expect(request).rejects.toBeInstanceOf(HerdrNotInstalled)
  })

  it('kills an oversized response process', async () => {
    const fake = connection('x'.repeat(2_000_001))
    await expect(herdrCall('terminal.list', {})).rejects.toThrow('too much data')
    expect(fake.child.kill).toHaveBeenCalledTimes(1)
  })

  it('kills a stalled connection and escalates if it does not close', async () => {
    vi.useFakeTimers()
    const fake = connection('', 0, false)
    const request = herdrCall('terminal.list', {})
    const rejected = expect(request).rejects.toThrow('Check existing Session runs')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    expect(fake.child.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fake.child.kill).toHaveBeenLastCalledWith('SIGKILL')
  })

  it('does not force-kill a connection that closes during escalation', async () => {
    vi.useFakeTimers()
    const fake = connection('', 0, false)
    const request = herdrCall('terminal.list', {})
    const rejected = expect(request).rejects.toThrow('Check existing Session runs')
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
    fake.child.emit('close', null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fake.child.kill).toHaveBeenCalledTimes(1)
  })
})
