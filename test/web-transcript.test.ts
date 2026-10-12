import { describe, expect, it } from 'vitest'
import type { Message } from '../src/core/providers/types.js'
import { transcriptOf } from '../src/gateways/web/transcript.js'

const register = (file: { path: string; name: string; mimeType: string }) => ({
  id: file.path,
  name: file.name,
  mimeType: file.mimeType,
  size: 0,
  image: false,
})

const of = (messages: Message[]) => transcriptOf(messages, register)

/** One turn: prose, a call, and the result that came back for it. */
function turn(call: { id: string; name: string; args?: unknown }, result?: { isError?: boolean }): Message[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'look' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool-call', id: call.id, name: call.name, args: call.args ?? { path: 'a.txt' } }] },
    ...(result
      ? [{ role: 'tool' as const, content: [{ type: 'tool-result' as const, id: call.id, name: call.name, content: 'ok', isError: result.isError === true }] }]
      : []),
  ]
}

const toolParts = (messages: Message[], level?: 'full' | 'name' | 'off') =>
  transcriptOf(messages, register, level).flatMap((message) => message.parts).filter((part) => part.kind === 'tool')

describe('transcriptOf — a turn keeps the order it happened in', () => {
  it('draws a tool line between the prose around it', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'reading first' },
          { type: 'text', text: 'Checking the file.' },
          { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'read_file', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'It is fine.' }] },
    ]

    // The thought, the words before the call, the call, and the words after it —
    // appended across the two steps of the one turn, in the order they were said.
    expect(of(messages).at(-1)?.parts).toEqual([
      { kind: 'reasoning', text: 'reading first' },
      { kind: 'text', text: 'Checking the file.' },
      { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.txt', state: 'done' } },
      { kind: 'text', text: 'It is fine.' },
    ])
  })

  it('leaves no tool line for a tool that draws its own thing', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'todo', args: { todos: [{ content: 'Step', status: 'pending' }] } },
        ],
      },
    ]

    expect(of(messages)[0]?.parts).toEqual([{ kind: 'todo', items: [{ content: 'Step', status: 'pending' }] }])
  })

  it('keeps the prose the person sent, and the files with it, on their own message', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', mimeType: 'image/png', path: '/img/a.png', name: 'a.png' },
        ],
      },
    ]

    expect(of(messages)[0]).toMatchObject({
      role: 'user',
      parts: [{ kind: 'text', text: 'see this' }],
      attachments: [{ name: 'a.png' }],
    })
  })

  it('carries when a message was said, dated from the start of the turn', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }], at: 1_000 },
      { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }], at: 2_000 },
      { role: 'assistant', content: [{ type: 'text', text: 'It is fine.' }], at: 3_500 },
    ]

    // The turn is drawn as one message, so it is dated when it began — the last
    // step's time is not the message's.
    expect(of(messages)).toMatchObject([
      { role: 'user', at: 1_000 },
      { role: 'assistant', at: 2_000 },
    ])
  })

  it('leaves the time absent on a message that carries none', () => {
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'look' }] }]

    expect(of(messages)[0]).not.toHaveProperty('at')
  })

  it('carries the raw copy of the turn, the tool result from its `tool` message included', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'read_file', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'It is fine.' }] },
    ]

    const raw = of(messages).at(-1)?.raw ?? ''
    expect(raw).toContain('Checking.')
    expect(raw).toContain('**read_file**')
    expect(raw).toContain('a.txt')
    expect(raw).toContain('**Result**')
    expect(raw).toContain('ok')
    expect(raw).toContain('It is fine.')
  })

  it('leaves the raw off a turn that is only prose', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
    ]

    expect(of(messages).at(-1)).not.toHaveProperty('raw')
  })
})

describe('transcriptOf — the display level is applied the same way the live turn applies it', () => {
  const messages = turn({ id: 'c1', name: 'read_file' }, {})

  it('draws the value beside the name at full detail', () => {
    expect(toolParts(messages, 'full')).toEqual([
      { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.txt', state: 'done' } },
    ])
  })

  it('withholds the value at name detail, rather than shortening the line', () => {
    expect(toolParts(messages, 'name')).toEqual([
      { kind: 'tool', tool: { name: 'read_file', text: 'read_file', state: 'done' } },
    ])
  })

  it('leaves the call out entirely at off, which is what the live turn does', () => {
    expect(toolParts(messages, 'off')).toEqual([])
  })

  it('defaults to full, so a caller that says nothing draws what it always did', () => {
    expect(toolParts(messages)).toEqual(toolParts(messages, 'full'))
  })
})

describe('transcriptOf — how a call ended', () => {
  it('says a call failed, which a reload used to hide', () => {
    expect(toolParts(turn({ id: 'c1', name: 'shell_command', args: { command: 'npm test' } }, { isError: true }))).toEqual([
      { kind: 'tool', tool: { name: 'shell_command', text: 'shell_command npm test', state: 'failed' } },
    ])
  })

  it('says a call finished when its result came back clean', () => {
    expect(toolParts(turn({ id: 'c1', name: 'grep' }, {}))).toEqual([
      { kind: 'tool', tool: { name: 'grep', text: 'grep a.txt', state: 'done' } },
    ])
  })

  it('says nothing about a call whose result never came, rather than guessing', () => {
    expect(toolParts(turn({ id: 'c1', name: 'grep' }))).toEqual([
      { kind: 'tool', tool: { name: 'grep', text: 'grep a.txt' } },
    ])
  })

  it('still says a call failed when the call itself is not drawn', () => {
    // `todo` draws the checklist in its own place, but a failure of it is news.
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'plan it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'todo', args: { todos: [{ content: 'Step', status: 'pending' }] } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'todo', content: 'no', isError: true }] },
    ]

    expect(toolParts(messages)).toEqual([{ kind: 'tool', tool: { name: 'todo', text: 'todo', state: 'failed' } }])
  })

  it('leaves a hidden call that went fine out of the transcript', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'plan it' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'todo', args: { todos: [{ content: 'Step', status: 'pending' }] } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'todo', content: 'ok', isError: false }] },
    ]

    expect(toolParts(messages)).toEqual([])
  })
})
