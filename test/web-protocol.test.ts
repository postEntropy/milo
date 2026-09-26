import { describe, expect, it } from 'vitest'
import { parseClientFrame, PROTOCOL_VERSION } from '../src/gateways/web/protocol.js'
import { displayEvent } from '../src/gateways/web/turn.js'

const output: unknown[] = []
const send = (frame: unknown) => output.push(frame)

describe('web protocol', () => {
  it('accepts only known client frame shapes', () => {
    expect(parseClientFrame({ type: 'hello', version: PROTOCOL_VERSION, conversationId: 'e76b3fc7-f93d-4ee2-a1d8-1cc6e7e7ab92' })?.type).toBe('hello')
    expect(parseClientFrame({ type: 'send', text: 'hello', intent: 'steer' })?.type).toBe('send')
    expect(parseClientFrame({ type: 'send', text: 'hello', intent: 'invented' })).toBeNull()
    expect(parseClientFrame({ type: 'control', action: 'delete' })).toBeNull()
    expect(parseClientFrame(null)).toBeNull()
  })

  it('keeps failures visible when tool lines are hidden', () => {
    output.length = 0
    displayEvent({ type: 'tool-start', id: '1', name: 'write_file', args: { path: 'a.txt' } }, 'turn', { tools: 'off', thinking: 'on' }, send as never)
    displayEvent({ type: 'tool-end', id: '1', name: 'write_file', result: 'failed', isError: true }, 'turn', { tools: 'off', thinking: 'on' }, send as never)
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ event: { delta: '❌ write_file failed\n' } })
  })

  it('hides reasoning only when configured off', () => {
    output.length = 0
    displayEvent({ type: 'reasoning-delta', delta: 'secret thought' }, 'turn', { tools: 'full', thinking: 'off' }, send as never)
    expect(output).toHaveLength(0)
    displayEvent({ type: 'text-delta', delta: 'answer' }, 'turn', { tools: 'full', thinking: 'off' }, send as never)
    expect(output).toMatchObject([{ event: { delta: 'answer' } }])
  })
})
