import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../src/core/providers/types.js'

// The page store is Milo's own: a scratch home keeps the test off the real one.
const home = mkdtempSync(path.join(os.tmpdir(), 'milo-drop-'))
process.env.MILO_HOME = home

const { dropOldFetchedPages, KEEP_PAGES_IN_CONTEXT } = await import('../src/core/sessions/compact.js')
const { fetchedPagePath, prunePages, savePage } = await import('../src/core/fetched.js')

afterAll(() => rmSync(home, { recursive: true, force: true }))
beforeEach(() => prunePages(0)) // nothing is kept between tests

const big = (label: string): string => `${label} ${'x'.repeat(5000)}`

/** The call and the result for one fetched page, the way the loop writes them. */
function pair(url: string, text: string, id: string): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', id, name: 'fetch_url', args: { url } }] },
    { role: 'tool', content: [{ type: 'tool-result', id, name: 'fetch_url', content: text }] },
  ]
}

const bodyOf = (messages: Message[], id: string): string => {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.id === id) return part.content
    }
  }
  return ''
}

describe('dropOldFetchedPages', () => {
  it('keeps the newest pages and names the file for the older ones', async () => {
    await savePage('https://a.test', big('a'))
    await savePage('https://b.test', big('b'))
    await savePage('https://c.test', big('c'))
    const messages: Message[] = [
      ...pair('https://a.test', big('a'), 'a'),
      ...pair('https://b.test', big('b'), 'b'),
      ...pair('https://c.test', big('c'), 'c'),
    ]

    dropOldFetchedPages(messages, 1)

    expect(bodyOf(messages, 'a')).toContain(fetchedPagePath('https://a.test'))
    expect(bodyOf(messages, 'b')).toContain(fetchedPagePath('https://b.test'))
    expect(bodyOf(messages, 'a')).toContain('dropped')
    // The newest page is untouched, still the text it was.
    expect(bodyOf(messages, 'c')).toBe(big('c'))
  })

  it('keeps the default window of pages', async () => {
    for (let n = 0; n < KEEP_PAGES_IN_CONTEXT + 2; n += 1) {
      await savePage(`https://k${n}.test`, big(`k${n}`))
    }
    const messages = Array.from({ length: KEEP_PAGES_IN_CONTEXT + 2 }, (_, n) =>
      pair(`https://k${n}.test`, big(`k${n}`), `k${n}`),
    ).flat()

    dropOldFetchedPages(messages)

    // The two oldest go; the newest KEEP_PAGES_IN_CONTEXT stay whole.
    expect(bodyOf(messages, 'k0')).toContain('dropped')
    expect(bodyOf(messages, 'k1')).toContain('dropped')
    expect(bodyOf(messages, `k${KEEP_PAGES_IN_CONTEXT + 1}`)).toBe(big(`k${KEEP_PAGES_IN_CONTEXT + 1}`))
  })

  it('leaves a page it cannot hand back', async () => {
    // Fetched, but never kept: the body is the only copy, so it stays.
    const messages = pair('https://lost.test', big('lost'), 'lost')

    dropOldFetchedPages(messages, 0)

    expect(bodyOf(messages, 'lost')).toBe(big('lost'))
  })

  it('leaves a short result alone', async () => {
    await savePage('https://short.test', 'a line')
    const messages = pair('https://short.test', 'a line', 'short')

    dropOldFetchedPages(messages, 0)

    expect(bodyOf(messages, 'short')).toBe('a line')
  })

  it('writes the same note on a second pass', async () => {
    await savePage('https://a.test', big('a'))
    await savePage('https://b.test', big('b'))
    const messages = [...pair('https://a.test', big('a'), 'a'), ...pair('https://b.test', big('b'), 'b')]

    dropOldFetchedPages(messages, 1)
    const once = bodyOf(messages, 'a')
    dropOldFetchedPages(messages, 1)

    expect(bodyOf(messages, 'a')).toBe(once)
  })
})
