import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatIn, formatStamp, formatWhen } from '../src/core/time.js'

/** A fixed noon, so every case is read against one known day. */
const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatWhen', () => {
  it('says a timestamp from the last minute as just now', () => {
    expect(formatWhen(NOW - 30_000)).toBe('just now')
  })

  it('reads the last hour in minutes', () => {
    expect(formatWhen(NOW - 10 * 60_000)).toBe('10 min ago')
  })

  it('reads earlier today in hours', () => {
    expect(formatWhen(NOW - 2 * 3_600_000)).toBe('2h ago')
  })

  it('says yesterday for the day before, whatever the hour', () => {
    expect(formatWhen(new Date(2026, 9, 21, 23, 30).getTime())).toBe('Yesterday')
  })

  it('writes an older day day-first, never the American order', () => {
    expect(formatWhen(new Date(2026, 9, 20, 8, 30).getTime())).toBe('20/10/2026')
  })

  it('names the day and a 24-hour clock when the instant is what is read', () => {
    expect(formatWhen(new Date(2026, 9, 22, 8, 5).getTime(), 'absolute')).toBe('Today, 08:05')
    expect(formatWhen(new Date(2026, 9, 21, 23, 30).getTime(), 'absolute')).toBe('Yesterday, 23:30')
    expect(formatWhen(new Date(2026, 9, 20, 8, 5).getTime(), 'absolute')).toBe('20/10/2026, 08:05')
  })

  it('names tomorrow for a time that has not come yet', () => {
    expect(formatWhen(new Date(2026, 9, 23, 9, 0).getTime(), 'absolute')).toBe('Tomorrow, 09:00')
  })
})

describe('formatStamp', () => {
  it('writes a record stamp that keeps its meaning when read later', () => {
    expect(formatStamp(new Date(2026, 9, 22, 21, 5).getTime())).toBe('2026-10-22 21:05')
  })
})

describe('formatIn', () => {
  it('reads the wait ahead in minutes, hours and days', () => {
    expect(formatIn(NOW + 3 * 60_000)).toBe('in 3 min')
    expect(formatIn(NOW + 2 * 3_600_000)).toBe('in 2h')
    expect(formatIn(NOW + 5 * 24 * 3_600_000)).toBe('in 5d')
  })

  it('says any moment for a time that has already come', () => {
    expect(formatIn(NOW - 1_000)).toBe('any moment')
  })
})
