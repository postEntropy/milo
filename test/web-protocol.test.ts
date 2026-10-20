import { describe, expect, it } from 'vitest'
import { helloVersion, parseClientFrame, PROTOCOL_VERSION, type ServerFrame } from '../src/gateways/web/protocol.js'
import { displayEvent } from '../src/gateways/web/turn.js'

const output: unknown[] = []
const send = (frame: unknown) => output.push(frame)

describe('web protocol', () => {
  it('accepts only known client frame shapes', () => {
    expect(parseClientFrame({ type: 'hello', version: PROTOCOL_VERSION, chatId: 'e76b3fc7-f93d-4ee2-a1d8-1cc6e7e7ab92' })?.type).toBe('hello')
    expect(parseClientFrame({ type: 'send', text: 'hello', intent: 'steer' })?.type).toBe('send')
    expect(parseClientFrame({ type: 'send', text: 'hello', intent: 'invented' })).toBeNull()
    expect(parseClientFrame({ type: 'control', action: 'delete' })).toBeNull()
    expect(parseClientFrame(null)).toBeNull()
  })

  it('reads the version off a hello before its shape is parsed', () => {
    // A frame written by an older protocol must be refused as a skew — the field it
    // named may no longer exist, so parsing it first would answer "unreadable".
    const older = { type: 'hello', version: PROTOCOL_VERSION - 1, conversationId: 'x' }
    expect(helloVersion(older)).toBe(PROTOCOL_VERSION - 1)
    expect(parseClientFrame(older)).toBeNull()
    expect(helloVersion({ type: 'send', version: PROTOCOL_VERSION })).toBeUndefined()
    expect(helloVersion('not a frame')).toBeUndefined()
  })

  it('takes the drawing flag on the handshake, and nothing else', () => {
    const hello = { type: 'hello', version: PROTOCOL_VERSION, chatId: 'e76b3fc7-f93d-4ee2-a1d8-1cc6e7e7ab92' }
    expect(parseClientFrame({ ...hello, genui: true })?.type).toBe('hello')
    expect(parseClientFrame({ ...hello, genui: false })?.type).toBe('hello')
    // The transports this replaced. A page still naming one is refused rather than
    // read as a flag meaning something it never meant.
    expect(parseClientFrame({ ...hello, genui: 'tool' })).toBeNull()
    expect(parseClientFrame({ ...hello, genui: 'block' })).toBeNull()
    expect(parseClientFrame({ ...hello, genui: 'canvas' })).toBeNull()
  })

  it('carries the planning switch, and refuses half of one', () => {
    expect(parseClientFrame({ type: 'control', action: 'plan', plan: true })?.type).toBe('control')
    expect(parseClientFrame({ type: 'control', action: 'plan', plan: false })?.type).toBe('control')
    // A switch without a state is not a switch.
    expect(parseClientFrame({ type: 'control', action: 'plan' })).toBeNull()
    expect(parseClientFrame({ type: 'control', action: 'plan', plan: 'on' })).toBeNull()
    // Approving names the act itself; the state is already on.
    expect(parseClientFrame({ type: 'control', action: 'approve-plan' })?.type).toBe('control')
  })

  it('carries a pinned destination, and refuses half of one', () => {
    const pinned = parseClientFrame({ type: 'send', text: 'every day at 8', target: { gateway: 'telegram', chatId: '123' } })
    // Half a target is not one: guessing the other half is how a routine goes quiet.
    expect(parseClientFrame({ type: 'send', text: 'x', target: { gateway: 'telegram' } })).toBeNull()
    expect(parseClientFrame({ type: 'send', text: 'x', target: { chatId: '123' } })).toBeNull()
    expect(parseClientFrame({ type: 'send', text: 'x', target: { gateway: 'email', chatId: '123' } })).toBeNull()
    expect(parseClientFrame({ type: 'send', text: 'x', target: { gateway: 'telegram', chatId: '  ' } })).toBeNull()
    expect(parseClientFrame({ type: 'send', text: 'x', target: null })).toBeNull()

    expect(pinned).toMatchObject({ target: { gateway: 'telegram', chatId: '123' } })
    expect(parseClientFrame({ type: 'send', text: 'plain' })).not.toHaveProperty('target')
  })

  it('accepts staged file ids and refuses malformed ids', () => {
    expect(parseClientFrame({ type: 'send', text: 'describe these', uploadIds: ['file-a', 'file-b'] }))
      .toMatchObject({ uploadIds: ['file-a', 'file-b'] })
    expect(parseClientFrame({ type: 'send', text: '', uploadIds: [1] })).toBeNull()
  })

  it('sends tool calls as events, not folded into the reply text', () => {
    output.length = 0
    displayEvent({ type: 'tool-start', id: '1', name: 'read_file', args: { path: 'a.txt' } }, 'turn', { tools: 'full', thinking: 'expanded' }, send as never)
    displayEvent({ type: 'tool-start', id: '2', name: 'read_file', args: { path: 'a.txt' } }, 'turn', { tools: 'name', thinking: 'expanded' }, send as never)
    expect(output).toMatchObject([
      { event: { type: 'tool-start', name: 'read_file', args: { path: 'a.txt' } } },
      { event: { type: 'tool-start', name: 'read_file', args: undefined } },
    ])
  })

  it('keeps failures visible when tool lines are hidden', () => {
    output.length = 0
    displayEvent({ type: 'tool-start', id: '1', name: 'write_file', args: { path: 'a.txt' } }, 'turn', { tools: 'off', thinking: 'expanded' }, send as never)
    displayEvent({ type: 'tool-end', id: '1', name: 'write_file', result: 'failed', isError: true }, 'turn', { tools: 'off', thinking: 'expanded' }, send as never)
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ event: { type: 'tool-end', name: 'write_file', isError: true } })
  })

  it('lets a thought ride either way, so a folded one can still be opened', () => {
    output.length = 0
    displayEvent({ type: 'reasoning-delta', delta: 'secret thought' }, 'turn', { tools: 'full', thinking: 'collapsed' }, send as never)
    displayEvent({ type: 'text-delta', delta: 'answer' }, 'turn', { tools: 'full', thinking: 'collapsed' }, send as never)
    expect(output).toMatchObject([{ event: { delta: 'secret thought' } }, { event: { delta: 'answer' } }])
  })

  it('carries the frame that says a session began or ended a turn', () => {
    // A type-level fixture: this line is what proves `sessions-changed` is a frame the
    // server may send, and it is additive, so no version bump rides with it.
    const frame: ServerFrame = { type: 'sessions-changed' }
    expect(frame).toEqual({ type: 'sessions-changed' })
  })

  it('carries the session plan state as its own frame', () => {
    const frame: ServerFrame = { type: 'plan', plan: true }
    expect(frame).toEqual({ type: 'plan', plan: true })
  })
})
