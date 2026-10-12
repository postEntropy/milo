/**
 * QR encoding, enough of it for one payload: the pairing link `milo pair` draws
 * and the phone scans. Byte mode, error-correction level M, versions 1–6 — the
 * six smallest symbols, which hold the address, the port and a six-digit code
 * with room to spare. A payload that does not fit is refused rather than drawn
 * wrong, and the caller prints the code by hand instead.
 *
 * Written out rather than taken from a package: the repo carries nine
 * dependencies and none of them draw a QR, and this is the one symbol the
 * product needs. It is checked against `qrencode`'s own matrices and decoded
 * back with `zbarimg` — see `test/qr.test.ts`.
 */

/** Error-correction level M: the 2-bit level code the format information carries. */
const LEVEL_M = 0b00

/**
 * Reed–Solomon blocks, level M, versions 1–6: `[count, totalCodewords, dataCodewords]`
 * groups per version, from ISO/IEC 18004. Groups repeat the same block shape, so
 * version 6 is four blocks of forty-three codewords holding twenty-seven each.
 */
const BLOCKS_M: readonly (readonly number[])[] = [
  [1, 26, 16],
  [1, 44, 28],
  [1, 70, 44],
  [2, 50, 32],
  [2, 67, 43],
  [4, 43, 27],
]

/** Alignment-pattern centres by version; version 1 has none, 2–6 have one. */
const ALIGNMENT: readonly (readonly number[])[] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]]

/** Bits left over after the codewords: 7 for versions 2–6, none for version 1. */
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7]

const EXP = new Uint8Array(256)
const LOG = new Uint8Array(256)
for (let i = 0; i < 8; i += 1) EXP[i] = 1 << i
for (let i = 8; i < 256; i += 1) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8]
for (let i = 0; i < 255; i += 1) LOG[EXP[i]] = i

const gexp = (n: number): number => EXP[((n % 255) + 255) % 255]
const glog = (n: number): number => LOG[n]

/** The generator polynomial for `ec` error-correction codewords, ∏(x − α^i). */
function generator(ec: number): number[] {
  let poly = [1]
  for (let i = 0; i < ec; i += 1) {
    // Multiply by (x + α^i): the old coefficients shift up, and a scaled copy
    // stays where it was.
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j += 1) {
      if (poly[j] === 0) continue
      next[j + 1] ^= poly[j]
      next[j] ^= gexp(glog(poly[j]) + i)
    }
    poly = next
  }
  return poly
}

/** The `ec` check codewords for one block, as the polynomial remainder. */
function ecc(data: readonly number[], ec: number): number[] {
  const remainder = [...data, ...new Array<number>(ec).fill(0)]
  // `generator` is built low power first, but the division cancels with the
  // leading term — x^ec — so it is applied from the top down. Getting this order
  // backwards leaves the check codewords wrong and the symbol unreadable.
  const gen = generator(ec)
  for (let i = 0; i < data.length; i += 1) {
    const factor = remainder[i]
    if (factor === 0) continue
    for (let j = 0; j <= ec; j += 1) {
      const coefficient = gen[ec - j]
      if (coefficient === 0) continue
      remainder[i + j] ^= gexp(glog(coefficient) + glog(factor))
    }
  }
  return remainder.slice(data.length)
}

const DATA_CAPACITY = BLOCKS_M.map((groups) => {
  let total = 0
  for (let i = 0; i < groups.length; i += 3) total += groups[i] * groups[i + 2]
  return total
})

export type QrOutcome = { ok: true; matrix: boolean[][] } | { ok: false; error: string }

/**
 * The symbol for `text`, as a square of dark (`true`) and light modules, quiet
 * zone included.
 */
export function qrMatrix(text: string): QrOutcome {
  const payload = new TextEncoder().encode(text)
  const version = DATA_CAPACITY.findIndex((capacity) => {
    // 4 bits of mode, 8 of length, the bytes, and room for the terminator.
    const needed = 4 + 8 + payload.length * 8 + 4
    return capacity * 8 >= needed
  }) + 1
  if (version < 1) {
    return { ok: false, error: `that is too long for a QR code (${payload.length} bytes)` }
  }

  const bits: number[] = []
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1)
  }
  push(0b0100, 4)
  push(payload.length, 8)
  for (const byte of payload) push(byte, 8)

  const capacityBits = DATA_CAPACITY[version - 1] * 8
  push(0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }
  const pad = [0xec, 0x11]
  let padIndex = 0
  while (codewords.length < DATA_CAPACITY[version - 1]) {
    codewords.push(pad[padIndex % 2])
    padIndex += 1
  }

  // The codewords as a flat stream of bits, most significant first, then the
  // remainder bits the version calls for.
  const stream: number[] = []
  for (const byte of interleave(codewords, BLOCKS_M[version - 1])) {
    for (let i = 7; i >= 0; i -= 1) stream.push((byte >> i) & 1)
  }
  for (let i = 0; i < REMAINDER_BITS[version]; i += 1) stream.push(0)

  const size = version * 4 + 17
  const matrix: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(-1))
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (row: number, col: number, dark: boolean, isFixed = true): void => {
    if (row < 0 || col < 0 || row >= size || col >= size) return
    matrix[row][col] = dark ? 1 : 0
    if (isFixed) fixed[row][col] = true
  }

  drawFunctionPatterns(version, size, ALIGNMENT[version], set)
  placeData(stream, matrix, size)

  const mask = chooseMask(matrix, fixed, size)
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!fixed[row][col] && masked(row, col, mask)) matrix[row][col] ^= 1
    }
  }
  drawFormat(size, mask, set)

  const quiet = 4
  const span = size + quiet * 2
  const out: boolean[][] = Array.from({ length: span }, () => new Array<boolean>(span).fill(false))
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) out[row + quiet][col + quiet] = matrix[row][col] === 1
  }
  return { ok: true, matrix: out }
}

/** Data codewords into blocks, then each block's check codewords, then interleaved. */
function interleave(codewords: readonly number[], groups: readonly number[]): number[] {
  const data: number[][] = []
  const check: number[][] = []
  let offset = 0
  for (let i = 0; i < groups.length; i += 3) {
    const count = groups[i]
    const total = groups[i + 1]
    const per = groups[i + 2]
    for (let block = 0; block < count; block += 1) {
      const chunk = codewords.slice(offset, offset + per)
      offset += per
      data.push(chunk)
      check.push(ecc(chunk, total - per))
    }
  }
  const out: number[] = []
  const longest = Math.max(...data.map((block) => block.length))
  for (let i = 0; i < longest; i += 1) {
    for (const block of data) if (i < block.length) out.push(block[i])
  }
  for (let i = 0; i < check[0].length; i += 1) {
    for (const block of check) out.push(block[i])
  }
  return out
}

function drawFunctionPatterns(
  version: number,
  size: number,
  alignment: readonly number[],
  set: (row: number, col: number, dark: boolean) => void,
): void {
  const finder = (top: number, left: number): void => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const row = top + r
        const col = left + c
        if (row < 0 || col < 0 || row >= size || col >= size) continue
        const edge = r === -1 || r === 7 || c === -1 || c === 7
        const ring = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        set(row, col, ring && (r === 0 || r === 6 || c === 0 || c === 6 || core) && !edge)
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  if (version >= 2) {
    const last = size - 7
    for (const row of alignment) {
      for (const col of alignment) {
        // The three corners already hold a finder pattern.
        if ((row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6)) continue
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            const distance = Math.max(Math.abs(r), Math.abs(c))
            set(row + r, col + c, distance !== 1)
          }
        }
      }
    }
  }

  // The format information: reserved here, written once the mask is known. The
  // two copies are not the same length — fifteen bits split 8 and 7 along row 8,
  // and 8 and 7 the other way — so the far sides are reserved apart.
  for (let i = 0; i <= 8; i += 1) {
    if (i === 6) continue // the timing column and row
    set(8, i, false)
    set(i, 8, false)
  }
  for (let i = 0; i < 8; i += 1) set(8, size - 1 - i, false)
  for (let i = 8; i < 15; i += 1) set(size - 15 + i, 8, false)
  // The one module that is always dark, between the bottom-left finder and the
  // format information.
  set(size - 8, 8, true)
}

function placeData(stream: readonly number[], matrix: number[][], size: number): void {
  let index = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i
      for (const c of [col, col - 1]) {
        if (matrix[row][c] !== -1) continue
        matrix[row][c] = index < stream.length ? stream[index] : 0
        index += 1
      }
    }
    upward = !upward
  }
}

function masked(row: number, col: number, mask: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0
    case 1: return row % 2 === 0
    case 2: return col % 3 === 0
    case 3: return (row + col) % 3 === 0
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

/** The mask with the lowest penalty, as the standard scores the eight. */
function chooseMask(matrix: number[][], fixed: boolean[][], size: number): number {
  let best = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = matrix.map((row, r) =>
      row.map((value, c) => (fixed[r][c] || !masked(r, c, mask) ? value : value ^ 1)),
    )
    drawFormat(size, mask, (row, col, dark) => {
      candidate[row][col] = dark ? 1 : 0
    })
    const score = penalty(candidate, size)
    if (score < bestScore) {
      bestScore = score
      best = mask
    }
  }
  return best
}

function penalty(matrix: readonly number[][], size: number): number {
  let score = 0
  const runs = (line: (index: number) => number): void => {
    let run = 0
    let previous = -1
    for (let i = 0; i < size; i += 1) {
      const value = line(i)
      if (value === previous) run += 1
      else {
        if (run >= 5) score += 3 + (run - 5)
        previous = value
        run = 1
      }
    }
    if (run >= 5) score += 3 + (run - 5)
  }
  for (let i = 0; i < size; i += 1) {
    runs((index) => matrix[i][index])
    runs((index) => matrix[index][i])
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = matrix[row][col]
      if (value === matrix[row][col + 1] && value === matrix[row + 1][col] && value === matrix[row + 1][col + 1]) {
        score += 3
      }
    }
  }

  const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const mirrored = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
  const matches = (at: (index: number) => number, start: number, wanted: readonly number[]): boolean => {
    for (let i = 0; i < wanted.length; i += 1) if (at(start + i) !== wanted[i]) return false
    return true
  }
  for (let i = 0; i < size; i += 1) {
    const row = (index: number): number => matrix[i][index]
    const col = (index: number): number => matrix[index][i]
    for (let start = 0; start + 11 <= size; start += 1) {
      if (matches(row, start, pattern) || matches(row, start, mirrored)) score += 40
      if (matches(col, start, pattern) || matches(col, start, mirrored)) score += 40
    }
  }

  let dark = 0
  for (let row = 0; row < size; row += 1) for (let col = 0; col < size; col += 1) dark += matrix[row][col]
  const total = size * size
  score += Math.floor(Math.abs((dark * 100) / total - 50) / 5) * 10
  return score
}

/** Level M and the mask, as BCH(15,5) with the fixed mask the standard applies. */
function drawFormat(size: number, mask: number, set: (row: number, col: number, dark: boolean) => void): void {
  const data = (LEVEL_M << 3) | mask
  let value = data << 10
  for (let i = 4; i >= 0; i -= 1) {
    if ((value >> (i + 10)) & 1) value ^= 0x537 << i
  }
  const bits = ((data << 10) | value) ^ 0x5412
  const bit = (index: number): boolean => ((bits >> index) & 1) === 1

  // Along column 8: beside the top-left finder, then the bottom-left one.
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) set(i, 8, bit(i))
    else if (i < 8) set(i + 1, 8, bit(i))
    else set(size - 15 + i, 8, bit(i))
  }
  // Along row 8: beside the top-right finder, then back to the top-left one.
  for (let i = 0; i < 15; i += 1) {
    if (i < 8) set(8, size - i - 1, bit(i))
    else if (i < 9) set(8, 7, bit(i))
    else set(8, 14 - i, bit(i))
  }
  // The one module that is always dark.
  set(size - 8, 8, true)
}

/**
 * The matrix as terminal lines, two modules to a cell with the upper half block,
 * so the modules come out square. Colours are set explicitly — black on white,
 * as a scanner expects — rather than left to the terminal's own theme.
 */
export function qrText(matrix: readonly boolean[][], indent = '  '): string[] {
  const size = matrix.length
  const rows = size + (size % 2)
  const lines: string[] = []
  for (let row = 0; row < rows; row += 2) {
    let line = indent
    for (let col = 0; col < size; col += 1) {
      const top = matrix[row]?.[col] === true ? '0;0;0' : '255;255;255'
      const bottom = row + 1 < size && matrix[row + 1][col] ? '0;0;0' : '255;255;255'
      line += `\u001b[38;2;${top}m\u001b[48;2;${bottom}m\u2580`
    }
    lines.push(`${line}\u001b[0m`)
  }
  return lines
}
