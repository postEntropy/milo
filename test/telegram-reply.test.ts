import { describe, expect, it } from 'vitest'
import { commandReplyParts } from '../src/gateways/telegram/reply.js'

const MAX = 4000

describe('commandReplyParts', () => {
  it('splits a reply that outgrows one message', () => {
    const reply = 'x'.repeat(9000)
    const { html, plain } = commandReplyParts({ handled: true, reply }, MAX)

    // No Markdown rendering for a plain command, and a whole message per part.
    expect(html).toEqual([])
    expect(plain.length).toBeGreaterThan(1)
    for (const part of plain) expect(part.length).toBeLessThanOrEqual(MAX)
    expect(plain.join('')).toBe(reply)
  })

  it('renders the Markdown to HTML, split the same way', () => {
    const markdown = '**bold**\n\n'.repeat(1000)
    const { html, plain } = commandReplyParts({ handled: true, reply: 'plain', markdown }, MAX)

    expect(plain).toEqual(['plain'])
    expect(html.length).toBeGreaterThan(1)
    expect(html.join('')).toContain('<b>bold</b>')
  })

  it('leaves a short reply as one message', () => {
    const { html, plain } = commandReplyParts(
      { handled: true, reply: 'ok', markdown: '**ok**' },
      MAX,
    )
    expect(plain).toEqual(['ok'])
    expect(html).toEqual(['<b>ok</b>'])
  })

  it('sends nothing when there is nothing to say', () => {
    expect(commandReplyParts({ handled: true }, MAX)).toEqual({ html: [], plain: [] })
  })
})
