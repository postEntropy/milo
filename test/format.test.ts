import { describe, expect, it } from 'vitest'
import { humanSize, shortenPath } from '../src/util/format.js'
import { formatSessionList, summarizeRecap } from '../src/core/sessions/index.js'

describe('humanSize', () => {
  it('says a size as a person reads it', () => {
    expect(humanSize(512)).toBe('512 B')
    expect(humanSize(1536)).toBe('1.5 KB')
    expect(humanSize(60817408)).toBe('58 MB')
  })

  it('drops a decimal that is only a zero — 448.0 KB is not more precise than 448 KB', () => {
    expect(humanSize(458752)).toBe('448 KB')
    expect(humanSize(1024 * 1024)).toBe('1 MB')
    expect(humanSize(1024 * 1024 * 1024)).toBe('1024 MB')
  })

  it('keeps a decimal that carries something', () => {
    expect(humanSize(1024 + 512)).toBe('1.5 KB')
  })
})

describe('shortenPath', () => {
  it('writes a path under the home directory the way a person does', () => {
    expect(shortenPath('/home/leo/.config/chromium', '/home/leo')).toBe('~/.config/chromium')
  })

  it('leaves anything else alone', () => {
    expect(shortenPath('/opt/helium', '/home/leo')).toBe('/opt/helium')
    expect(shortenPath('/home/leo', '/home/leo')).toBe('~')
  })

  it('is not fooled by a sibling whose name merely starts the same', () => {
    // `/home/user2` is not inside `/home/user`, and `~2/foo` is a path
    // that leads nowhere.
    expect(shortenPath('/home/user2/foo', '/home/user')).toBe('/home/user2/foo')
  })

  it('copes with no home to shorten against', () => {
    expect(shortenPath('/somewhere', '')).toBe('/somewhere')
  })
})

describe('summarizeRecap', () => {
  it('extracts the first bullet and strips bullet markers', () => {
    const recap = '- First point discussing setup.\n- Second point.\n- Third point.'
    expect(summarizeRecap(recap, 'fallback')).toBe('First point discussing setup.')
  })

  it('handles asterisk and numbered bullets', () => {
    expect(summarizeRecap('* Star bullet', 'fallback')).toBe('Star bullet')
    expect(summarizeRecap('1. Numbered bullet', 'fallback')).toBe('Numbered bullet')
  })

  it('falls back to preview when recap is undefined or empty', () => {
    expect(summarizeRecap(undefined, 'initial prompt')).toBe('initial prompt')
    expect(summarizeRecap('', 'initial prompt')).toBe('initial prompt')
    expect(summarizeRecap('   \n  ', 'initial prompt')).toBe('initial prompt')
  })

  it('truncates overly long recap bullets', () => {
    const long = `- ${'a'.repeat(200)}`
    const result = summarizeRecap(long, 'fallback', 50)
    expect(result.length).toBe(50)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('formatSessionList', () => {
  it('formats empty session list', () => {
    expect(formatSessionList([])).toBe('Sessions\n\nNothing saved yet. /new starts one.')
    expect(formatSessionList([], { markdown: true })).toBe('🗂 **Sessions**\n\nNothing saved yet. `/new` starts one.')
  })

  it('pages sessions in chunks of 5 by default', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => ({
      id: `s-${i + 1}`,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 1,
      preview: `msg ${i + 1}`,
    }))

    const p1 = formatSessionList(sessions, { page: 1 })
    expect(p1).toContain('Sessions (page 1/2)')
    expect(p1).toContain('s-1')
    expect(p1).toContain('s-5')
    expect(p1).not.toContain('s-6')
    expect(p1).toContain('Next: /sessions 2')

    const p2 = formatSessionList(sessions, { page: 2 })
    expect(p2).toContain('Sessions (page 2/2)')
    expect(p2).toContain('s-6')
    expect(p2).toContain('s-7')
    expect(p2).not.toContain('Next: /sessions')
  })
})
