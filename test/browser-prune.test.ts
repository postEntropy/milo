import { describe, expect, it } from 'vitest'
import type { Message } from '../src/core/providers/types.js'
import { dropOldSnapshots, estimateTokens } from '../src/core/sessions/compact.js'

/**
 * A page snapshot rides every request that follows it, so a task that looks at
 * the page after every action would otherwise pay for the whole session's worth
 * of them on each step. These are the rules that keep it bounded.
 */
const snapshot = (name: string, body: string): Message => ({
  role: 'tool',
  content: [{ type: 'tool-result', id: 'c1', name, content: body }],
})

const long = (headline: string) => `${headline}\n${'element '.repeat(200)}`

const bodies = (messages: Message[]): string[] =>
  messages.map((message) => {
    const part = message.content[0]
    return part?.type === 'tool-result' ? part.content : ''
  })

describe('dropOldSnapshots', () => {
  it('keeps the last two and trims the older ones to their headline', () => {
    const messages = [
      snapshot('browser_open', long('https://a.test/')),
      snapshot('browser_act', long('clicked r1')),
      snapshot('browser_act', long('typed into r4')),
    ]
    dropOldSnapshots(messages)

    const [first, second, third] = bodies(messages)
    expect(first).toContain('https://a.test/')
    expect(first).toContain('[page snapshot dropped')
    expect(first).not.toContain('element element element')
    // The two most recent are untouched: they are what the next action is
    // chosen from.
    expect(second).toBe(long('clicked r1'))
    expect(third).toBe(long('typed into r4'))
  })

  it('leaves a short result alone — a line has nothing to give up', () => {
    const messages = [snapshot('browser_act', 'clicked r7'), snapshot('browser_act', long('clicked r8'))]
    dropOldSnapshots(messages)
    expect(bodies(messages)[0]).toBe('clicked r7')
  })

  it('ignores a big result that is not a page', () => {
    const messages = [snapshot('shell_command', long('$ npm test')), snapshot('browser_act', long('clicked r1'))]
    dropOldSnapshots(messages)
    expect(bodies(messages)[0]).toBe(long('$ npm test'))
  })

  it('is idempotent', () => {
    const messages = [snapshot('browser_open', long('https://a.test/')), snapshot('browser_act', long('clicked r1'))]
    dropOldSnapshots(messages)
    const once = bodies(messages)[0]
    dropOldSnapshots(messages)
    expect(bodies(messages)[0]).toBe(once)
  })

  it('honours a keep of zero, and one of -1 means leave everything', () => {
    const all = () => [
      snapshot('browser_open', long('a')),
      snapshot('browser_act', long('b')),
      snapshot('browser_act', long('c')),
    ]
    const none = all()
    dropOldSnapshots(none, 0)
    expect(bodies(none).every((body) => body.includes('[page snapshot dropped'))).toBe(true)

    const untouched = all()
    dropOldSnapshots(untouched, -1)
    expect(bodies(untouched)).toEqual([long('a'), long('b'), long('c')])
  })

  it('bounds the cost however long the task runs — ten looks are not ten times the price', () => {
    const messages: Message[] = [snapshot('browser_open', long('https://a.test/'))]
    for (let step = 1; step <= 9; step += 1) messages.push(snapshot('browser_act', long(`clicked r${step}`)))

    const threeSnapshots = estimateTokens([snapshot('browser_open', long('x')), snapshot('browser_act', long('x')), snapshot('browser_act', long('x'))])
    const before = estimateTokens(messages)
    dropOldSnapshots(messages)

    // Two kept verbatim, eight trimmed to a headline: the request stops growing
    // with the number of steps, which is the whole point.
    expect(estimateTokens(messages)).toBeLessThan(threeSnapshots)
    expect(before).toBeGreaterThan(threeSnapshots * 3)
  })
})
