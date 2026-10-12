import { describe, expect, it } from 'vitest'
import { qrMatrix, qrText } from '../src/core/qr.js'

/**
 * The encoder is checked here for structure, version choice and the round trip
 * from modules back to the codewords it meant to place. The error-correction
 * codewords themselves were verified against `qrencode`'s own symbols and decoded
 * back with `zbarimg` (both agree and read the payload) — re-run that by hand
 * after touching Reed–Solomon, since no dependency here can decode.
 */
const sizeOf = (text: string): number => {
  const made = qrMatrix(text)
  if (!made.ok) throw new Error(made.error)
  return made.matrix.length - 8
}

const dark = (matrix: readonly boolean[][], row: number, col: number): boolean => matrix[row + 4][col + 4]

describe('the pairing QR', () => {
  it('picks the smallest version that holds the payload', () => {
    // Sixteen data codewords at version 1: four of mode, eight of length, the
    // bytes, and room for the terminator. Fourteen bytes is exactly the ceiling.
    expect(sizeOf('a')).toBe(21)
    expect(sizeOf('x'.repeat(14))).toBe(21)
    expect(sizeOf('x'.repeat(15))).toBe(25)
    expect(sizeOf('x'.repeat(100))).toBe(41)
  })

  it('refuses a payload the versions it knows cannot hold, rather than drawing one wrong', () => {
    const made = qrMatrix('x'.repeat(200))
    expect(made.ok).toBe(false)
    if (made.ok) return
    expect(made.error).toContain('too long')
  })

  it('writes the three finder patterns, the timing rows and the always-dark module', () => {
    const made = qrMatrix('milo://pair?v=1&host=1.2.3.4&port=7717&code=482913')
    if (!made.ok) throw new Error(made.error)
    const size = made.matrix.length - 8

    for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < 7; c += 1) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
          expect(dark(made.matrix, top + r, left + c)).toBe(ring || core)
        }
      }
    }
    for (let i = 8; i < size - 8; i += 1) {
      expect(dark(made.matrix, 6, i)).toBe(i % 2 === 0)
      expect(dark(made.matrix, i, 6)).toBe(i % 2 === 0)
    }
    expect(dark(made.matrix, size - 8, 8)).toBe(true)
  })

  it('leaves a four-module quiet zone of light around the symbol', () => {
    const made = qrMatrix('a')
    if (!made.ok) throw new Error(made.error)
    const span = made.matrix.length
    for (let i = 0; i < span; i += 1) {
      expect(made.matrix[0][i]).toBe(false)
      expect(made.matrix[span - 1][i]).toBe(false)
      expect(made.matrix[i][0]).toBe(false)
      expect(made.matrix[i][span - 1]).toBe(false)
    }
  })

  it('carries the same format information in both copies, naming level M', () => {
    const made = qrMatrix('milo://pair?v=1&host=1.2.3.4&port=7717&code=482913')
    if (!made.ok) throw new Error(made.error)
    const size = made.matrix.length - 8

    const column = (i: number): boolean =>
      i < 6 ? dark(made.matrix, i, 8) : i < 8 ? dark(made.matrix, i + 1, 8) : dark(made.matrix, size - 15 + i, 8)
    const row = (i: number): boolean =>
      i < 8 ? dark(made.matrix, 8, size - 1 - i) : i < 9 ? dark(made.matrix, 8, 7) : dark(made.matrix, 8, 14 - i)

    let along = 0
    let across = 0
    for (let i = 0; i < 15; i += 1) {
      if (column(i)) along |= 1 << i
      if (row(i)) across |= 1 << i
    }
    expect(along).toBe(across)
    const data = (along ^ 0x5412) >> 10
    expect((data >> 3) & 3).toBe(0b00) // level M
    expect(data & 7).toBeLessThan(8)
  })

  it('round-trips: the modules hold the bytes it set out to place, mask and all', () => {
    // A payload short enough for a single block, so the codewords run in order —
    // from version 4 up the blocks interleave, and the second byte is no longer
    // the length's tail.
    const text = 'milo://pair?code=482913'
    const made = qrMatrix(text)
    if (!made.ok) throw new Error(made.error)
    const size = made.matrix.length - 8

    // The mask the symbol names, read from its own format information.
    let bits = 0
    for (let i = 0; i < 15; i += 1) {
      const v = i < 6 ? dark(made.matrix, i, 8) : i < 8 ? dark(made.matrix, i + 1, 8) : dark(made.matrix, size - 15 + i, 8)
      if (v) bits |= 1 << i
    }
    const mask = ((bits ^ 0x5412) >> 10) & 7
    const flips = (r: number, c: number): boolean => {
      switch (mask) {
        case 0: return (r + c) % 2 === 0
        case 1: return r % 2 === 0
        case 2: return c % 3 === 0
        case 3: return (r + c) % 3 === 0
        case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
        case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
        case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
        default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
      }
    }

    // The map of modules that are not data: finders and their separators, timing,
    // format, the dark module and — at version 2 and up — the alignment patterns.
    const version = (size - 17) / 4
    const ALIGN: readonly (readonly number[])[] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]]
    const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    const mark = (r: number, c: number): void => {
      if (r >= 0 && c >= 0 && r < size && c < size) fixed[r][c] = true
    }
    for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r += 1) for (let c = -1; c <= 7; c += 1) mark(top + r, left + c)
    }
    for (let i = 8; i < size - 8; i += 1) {
      mark(6, i)
      mark(i, 6)
    }
    for (let i = 0; i <= 8; i += 1) {
      if (i === 6) continue
      mark(8, i)
      mark(i, 8)
    }
    for (let i = 0; i < 8; i += 1) {
      mark(8, size - 1 - i)
      mark(size - 1 - i, 8)
    }
    for (const ar of ALIGN[version] ?? []) {
      for (const ac of ALIGN[version] ?? []) {
        if (fixed[ar][ac]) continue
        for (let r = -2; r <= 2; r += 1) for (let c = -2; c <= 2; c += 1) mark(ar + r, ac + c)
      }
    }

    const stream: number[] = []
    let upward = true
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5
      for (let i = 0; i < size; i += 1) {
        const r = upward ? size - 1 - i : i
        for (const c of [col, col - 1]) {
          if (fixed[r][c]) continue
          stream.push(dark(made.matrix, r, c) !== flips(r, c) ? 1 : 0)
        }
      }
      upward = !upward
    }

    // Mode 0100 then an eight-bit length, so the payload starts at bit 12 — not
    // on a byte boundary — and runs to the end of what was placed.
    const read = (offset: number, width: number): number =>
      stream.slice(offset, offset + width).reduce((value, bit) => (value << 1) | bit, 0)
    const payload = new TextEncoder().encode(text)
    expect(read(0, 4)).toBe(0b0100)
    expect(read(4, 8)).toBe(payload.length)
    const expected: number[] = []
    for (const byte of payload) {
      for (let i = 7; i >= 0; i -= 1) expected.push((byte >> i) & 1)
    }
    expect(stream.slice(12, 12 + expected.length)).toEqual(expected)
  })
})

describe('the terminal rendering', () => {
  it('draws two modules per cell, in black on white, quiet zone included', () => {
    const made = qrMatrix('a')
    if (!made.ok) throw new Error(made.error)
    const lines = qrText(made.matrix, '')
    expect(lines).toHaveLength(Math.ceil(made.matrix.length / 2))
    // Each line opens with the explicit colours, so the symbol does not depend on
    // which way round the terminal's own theme is.
    for (const line of lines) expect(line).toContain('\u001b[38;2;')
    expect(lines[0]).toContain('255;255;255')
  })
})
