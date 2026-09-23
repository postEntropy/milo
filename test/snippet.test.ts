import { describe, expect, it } from 'vitest'
import { condense } from '../src/core/search/snippet.js'

describe('condense', () => {
  it('collapses runs of whitespace into single spaces', () => {
    expect(condense('  a\n\n\tb  ')).toBe('a b')
  })

  it('leaves short text alone', () => {
    expect(condense('the news')).toBe('the news')
  })

  it('cuts to the limit with an ellipsis', () => {
    const out = condense('x'.repeat(2000), 100)
    expect(out).toHaveLength(100)
    expect(out.endsWith('…')).toBe(true)
  })

  it('defaults to a 1200 character ceiling', () => {
    expect(condense('y'.repeat(5000))).toHaveLength(1200)
  })
})
