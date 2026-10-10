import { describe, expect, it } from 'vitest'
import type { Message } from '../src/core/providers/types.js'
import { rawTurn } from '../src/gateways/raw.js'

describe('rawTurn — a turn copied whole', () => {
  it('keeps the model’s words verbatim, a genui block and all', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'draw me a chart' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here you go.\n\n```genui\n{"tree":{"kind":"text","value":"hi"}}\n```' }],
      },
    ]

    const raw = rawTurn(messages)
    expect(raw).toContain('Here you go.')
    // The block survives as the JSON the model wrote — not the drawn widget.
    expect(raw).toContain('```genui')
    expect(raw).toContain('{"tree":{"kind":"text","value":"hi"}}')
    // The person's own words are their message, and are not copied with the answer.
    expect(raw).not.toContain('draw me a chart')
  })

  it('draws a thought, the words, the call with its arguments, and the result, in order', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'let me look' },
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'read_file', content: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ]

    const raw = rawTurn(messages) ?? ''
    expect(raw).toContain('**Reasoning**')
    expect(raw).toContain('let me look')
    expect(raw).toContain('Checking.')
    expect(raw).toContain('**read_file**')
    expect(raw).toContain('"path": "a.txt"')
    expect(raw).toContain('**Result**')
    expect(raw).toContain('hello')
    expect(raw).toContain('Done.')

    // And in the order the turn happened in.
    expect(raw.indexOf('**Reasoning**')).toBeLessThan(raw.indexOf('Checking.'))
    expect(raw.indexOf('Checking.')).toBeLessThan(raw.indexOf('**read_file**'))
    expect(raw.indexOf('**read_file**')).toBeLessThan(raw.indexOf('**Result**'))
    expect(raw.indexOf('**Result**')).toBeLessThan(raw.indexOf('Done.'))
  })

  it('says a tool failed, the way the tool line does', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'shell_command', args: { command: 'false' } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'shell_command', content: 'exit 1', isError: true }] },
    ]

    expect(rawTurn(messages)).toContain('**Result — it failed**')
  })

  it('fences a block whose own text holds backticks, so it cannot spill out', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read_file', args: { path: 'a.md' } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'read_file', content: '```\nx\n```' }] },
    ]

    // Four backticks: the fence is measured against its contents, not guessed at.
    expect(rawTurn(messages)).toContain('````')
  })

  it('is nothing at all for a turn that is only prose', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello there.' }] },
    ]

    expect(rawTurn(messages)).toBeNull()
  })

  it('is nothing for prose with an ordinary code fence — that is not a widget', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'Try this:\n\n```\nconst x = 1\n```' }] },
    ]

    expect(rawTurn(messages)).toBeNull()
  })
})
