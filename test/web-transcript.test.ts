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
      { kind: 'tool', tool: { name: 'read_file', text: 'read_file a.txt' } },
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
})
