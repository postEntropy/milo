import { describe, expect, it } from 'vitest'
import { formatTokens, humanSize, shortenPath } from '../src/util/format.js'
import { formatSessionList, quotedLead, sessionLabel, sessionRowLabel, statusText, summarizeRecap } from '../src/core/sessions/index.js'

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

describe('sessionLabel', () => {
  it('prefers the name, and falls back to the words it opened with', () => {
    expect(sessionLabel({ title: 'Folding transcripts', preview: 'how do I fold?' })).toBe('Folding transcripts')
    expect(sessionLabel({ preview: 'how do I fold?' })).toBe('how do I fold?')
    expect(sessionLabel({})).toBe('')
  })
})

describe('sessionRowLabel', () => {
  it('carries on through the recap to one word for a session nothing was said in', () => {
    expect(sessionRowLabel({ title: 'Folding transcripts', preview: 'how do I fold?' })).toBe('Folding transcripts')
    expect(sessionRowLabel({ preview: 'how do I fold?' })).toBe('how do I fold?')
    // The words can be missing while what the session was about is not — the phone's own
    // copy of this rule had no recap in it, so the same session read under two names.
    expect(sessionRowLabel({ recap: '- styled the settings screen' })).toBe('- styled the settings screen')
    expect(sessionRowLabel({})).toBe('New session')
  })
})

describe('formatTokens', () => {
  it('keeps a tenth below ten thousand and drops it above, where it is noise', () => {
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(8300)).toBe('8.3k')
    expect(formatTokens(22100)).toBe('22k')
    expect(formatTokens(22000)).toBe('22k')
    // A count that reads `220k` must not be followed by `1000k`.
    expect(formatTokens(1250000)).toBe('1.3M')
  })
})

describe('statusText', () => {
  it('says where a turn is, in the words the row shows', () => {
    expect(statusText({ type: 'waiting' })).toBe('Waiting for this session to free up…')
    expect(statusText({ type: 'waited', ms: 3400 })).toBe('Session freed after 3.4s.')
    expect(statusText({ type: 'compacting' })).toBe('Tidying the context…')
    // The correction's own words are the event's `text`; the row says what happened to it.
    expect(statusText({ type: 'steer', text: 'no, b.txt' })).toBe('Correction received by Milo.')
    expect(statusText({ type: 'aborted' })).toBe('Stopped · the partial reply was kept.')
    expect(statusText({ type: 'error', message: 'provider exploded' })).toBe('Error: provider exploded')
  })

  it('says what a fold came to, and what another surface left behind', () => {
    expect(statusText({ type: 'compacted', ms: 1200, folded: 3, tokens: 900, summarized: true }))
      .toBe('🗜 Compacted: 3 turns (~900 tokens) folded into the summary in 1.2s.')
    expect(statusText({ type: 'rebased', added: 2, removed: 1, compacted: false }))
      .toBe('Session updated by another surface (2 new messages and 1 message dropped elsewhere).')
  })

  it('says nothing where there is nothing to say', () => {
    // A finished turn is not news, so a row with nothing to report keeps the line it is
    // on — and a step that draws its own thing says nothing about the row either.
    expect(statusText({ type: 'done', finishReason: 'stop' })).toBeUndefined()
    expect(statusText({ type: 'text-delta', delta: 'hi' })).toBeUndefined()
    // A capped answer otherwise reads as a complete one.
    expect(statusText({ type: 'done', finishReason: 'length' })).toBe('The reply hit the output limit.')
  })
})

describe('formatSessionList', () => {
  it('formats empty session list', () => {
    expect(formatSessionList([])).toBe('Sessions\n\nNothing saved yet. /new starts one.')
    expect(formatSessionList([], { markdown: true })).toBe('🗂 **Sessions**\n\nNothing saved yet. `/new` starts one.')
  })

  it('names a session without a name by the words it opened with', () => {
    // The terminal shows a bare `calm-otter-7` for a session nobody named while the
    // browser and the phone already draw what it was about — the same session under
    // two names. The id stays in front either way: it is what `/resume` takes.
    const list = formatSessionList([{
      id: 'calm-otter-7',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 1,
      preview: 'how do I fold a transcript?',
      label: 'how do I fold a transcript?',
    }])

    expect(list).toContain('calm-otter-7 — how do I fold a transcript?')
    // Not said twice: the body only carries what the label does not.
    expect(list.match(/how do I fold a transcript\?/g)).toHaveLength(1)
  })

  it('says what a named session was about under its name', () => {
    const list = formatSessionList([{
      id: 'calm-otter-7',
      title: 'Folding transcripts',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 2,
      preview: 'how do I fold a transcript?',
      label: 'Folding transcripts',
    }])

    expect(list).toContain('calm-otter-7 — Folding transcripts')
    expect(list).toContain('how do I fold a transcript?')
  })

  it('shows the first bullet of a recap as the body', () => {
    const list = formatSessionList([{
      id: 'calm-otter-7',
      title: 'Folding transcripts',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 2,
      preview: 'how do I fold a transcript?',
      label: 'Folding transcripts',
      recap: '- What the session was about\n- more',
    }])

    expect(list).toContain('What the session was about')
    expect(list).not.toContain('more')
  })

  it('leaves the bare id for a session nothing was said in', () => {
    const list = formatSessionList([
      { id: 'empty-otter-1', createdAt: 0, updatedAt: 0, messageCount: 0, preview: '', label: 'New session' },
    ])

    expect(list).toContain('empty-otter-1')
    expect(list).not.toContain('empty-otter-1 — ')
  })

  it('pages sessions in chunks of 5 by default', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => ({
      id: `s-${i + 1}`,
      createdAt: 0,
      updatedAt: 0,
      messageCount: 1,
      preview: `msg ${i + 1}`,
      label: `msg ${i + 1}`,
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

describe('quotedLead', () => {
  it('quotes every line of the words picked out of an answer', () => {
    expect(quotedLead('one line')).toBe('> one line\n\n')
    expect(quotedLead('first\nsecond')).toBe('> first\n> second\n\n')
  })

  it('keeps an empty line as a quoted empty line', () => {
    expect(quotedLead('first\n\nsecond')).toBe('> first\n> \n> second\n\n')
  })
})
