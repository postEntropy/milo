import { describe, expect, it } from 'vitest'
import { chunk } from '../src/gateways/chunk.js'

describe('chunk', () => {
  it('leaves a message that fits alone', () => {
    expect(chunk('hello', 100)).toEqual(['hello'])
  })

  it('has nothing to send for nothing', () => {
    expect(chunk('   ', 100)).toEqual([])
  })

  it('breaks on a line boundary when one is near the limit', () => {
    const text = `${'a'.repeat(60)}\n${'b'.repeat(60)}`
    const parts = chunk(text, 70)
    expect(parts).toEqual(['a'.repeat(60), 'b'.repeat(60)])
  })

  it('falls back to a word boundary when there is no newline', () => {
    const text = `${'a'.repeat(60)} ${'b'.repeat(60)}`
    const parts = chunk(text, 70)
    expect(parts[0]).toBe('a'.repeat(60))
    expect(parts[1]).toBe('b'.repeat(60))
  })

  it('cuts hard rather than dropping anything when there is nowhere to break', () => {
    const text = 'a'.repeat(200)
    const parts = chunk(text, 80)
    expect(parts.every((part) => part.length <= 80)).toBe(true)
    expect(parts.join('')).toBe(text)
  })
})
