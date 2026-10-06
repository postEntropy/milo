import { describe, expect, it } from 'vitest'
import { commandReplyParts } from '../src/gateways/telegram/reply.js'
import { toPlain } from '../src/gateways/telegram/html.js'

const MAX = 4000

describe('commandReplyParts', () => {
  it('splits a reply that outgrows one message', () => {
    const reply = 'x'.repeat(9000)
    const { parts, markdown } = commandReplyParts({ handled: true, reply }, MAX)

    // No Markdown rendering for a plain command, and a whole message per part.
    expect(markdown).toBe(false)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX)
    expect(parts.join('')).toBe(reply)
  })

  it('splits the Markdown when the command has a rendering for it', () => {
    const markdown = '**bold**\n\n'.repeat(1000)
    const { parts, markdown: rich } = commandReplyParts({ handled: true, reply: 'plain', markdown }, MAX)

    expect(rich).toBe(true)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toContain('**bold**')
  })

  it('leaves a short reply as one message', () => {
    const { parts, markdown } = commandReplyParts(
      { handled: true, reply: 'ok', markdown: '**ok**' },
      MAX,
    )
    expect(parts).toEqual(['**ok**'])
    expect(markdown).toBe(true)
  })

  it('sends nothing when there is nothing to say', () => {
    expect(commandReplyParts({ handled: true }, MAX)).toEqual({ parts: [], markdown: false })
  })

  it('keeps each part its own slice, so a fallback cannot repeat an earlier one', () => {
    const markdown = `ALFA\n\n${'x'.repeat(500)}\n\nOMEGA`
    const { parts } = commandReplyParts({ handled: true, reply: 'plain', markdown }, 200)

    expect(parts.length).toBeGreaterThan(1)
    // The part that falls back to plain is that part, not the whole reply again:
    // the words of the first part never reach the last one.
    expect(toPlain(parts[0]!)).toContain('ALFA')
    expect(toPlain(parts[0]!)).not.toContain('OMEGA')
    expect(toPlain(parts.at(-1)!)).toContain('OMEGA')
  })
})
