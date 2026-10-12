import { describe, expect, it } from 'vitest'
import { buildSuggestions, defaultSuggestions } from '../web/src/chat/suggestions.js'

const session = (
  id: string,
  over: Partial<{ title: string; preview: string; messageCount: number }> = {},
) => ({ id, preview: '', messageCount: 1, ...over })

describe('buildSuggestions', () => {
  it('offers the standing four when nothing is known yet', () => {
    expect(buildSuggestions({ sessions: [] })).toEqual(defaultSuggestions)
  })

  it('offers to open a recent session again, rather than starting from nothing', () => {
    const cards = buildSuggestions({ sessions: [session('calm-otter-7', { title: 'Deploy status' })] })
    expect(cards[0]).toEqual({
      icon: 'history',
      title: 'Deploy status',
      detail: 'Pick up where you left off',
      action: 'resume:calm-otter-7',
    })
  })

  it('never offers the session already on screen, nor one that never spoke', () => {
    const cards = buildSuggestions({
      sessions: [session('here', { title: 'This one' }), session('silent', { messageCount: 0 }), session('past', { title: 'That one' })],
      currentId: 'here',
    })
    const titles = cards.map((card) => card.title)
    expect(titles).toContain('That one')
    expect(titles).not.toContain('This one')
    expect(titles).not.toContain('silent')
  })

  it('offers only the most recent session back, leaving the rest of the home for what is new', () => {
    const sessions = [
      session('newest', { title: 'Newest' }),
      session('older', { title: 'Older' }),
      session('oldest', { title: 'Oldest' }),
    ]
    const titles = buildSuggestions({ sessions }).map((card) => card.title)

    expect(titles).toContain('Newest')
    expect(titles).not.toContain('Older')
    expect(titles).not.toContain('Oldest')
  })

  it('draws no more than four cards', () => {
    const sessions = Array.from({ length: 6 }, (_, index) => session(`s-${index}`, { title: `Session ${index}` }))
    expect(buildSuggestions({ sessions })).toHaveLength(4)
  })

  it('lets the model’s ideas take the slots the standing four would hold', () => {
    const ideas = [
      { title: 'Investigate the deploy', prompt: 'Why did the deploy fail last night?' },
      { title: 'Tidy the memory', prompt: 'Help me clean up what you remember.' },
    ]
    const cards = buildSuggestions({ sessions: [], ideas })

    expect(cards[0]).toEqual({
      icon: 'spark',
      title: 'Investigate the deploy',
      detail: 'Why did the deploy fail last night?',
      prompt: 'Why did the deploy fail last night?',
    })
    expect(cards[1].title).toBe('Tidy the memory')
    // Ideas replace the standing four, and the standing four pad a short list.
    expect(cards.slice(2).map((card) => card.title)).toEqual(defaultSuggestions.slice(0, 2).map((card) => card.title))
  })

  it('keeps a recent session ahead of the ideas', () => {
    const cards = buildSuggestions({
      sessions: [session('calm-otter-7', { title: 'Deploy status' })],
      ideas: [{ title: 'Investigate the deploy', prompt: 'Why did it fail?' }],
    })

    expect(cards[0].title).toBe('Deploy status')
    expect(cards[1].title).toBe('Investigate the deploy')
  })

  it('stands on the four when no ideas have arrived', () => {
    expect(buildSuggestions({ sessions: [], ideas: null })).toEqual(defaultSuggestions)
  })
})
