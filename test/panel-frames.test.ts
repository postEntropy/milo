import { describe, expect, it } from 'vitest'
import { boundaryOf, frameParser } from '../web/src/panel/frames.js'

const encoder = new TextEncoder()

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** One part as the server writes it: a boundary, its headers, the bytes, a CRLF. */
function part(boundary: string, payload: Uint8Array): Uint8Array {
  return concat(
    encoder.encode(`--${boundary}\r\ncontent-type: image/jpeg\r\ncontent-length: ${payload.length}\r\n\r\n`),
    payload,
    encoder.encode('\r\n'),
  )
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

describe('boundaryOf', () => {
  it('reads the boundary out of a multipart content type', () => {
    expect(boundaryOf('multipart/x-mixed-replace; boundary=milo-browser-frame')).toBe('milo-browser-frame')
    expect(boundaryOf('multipart/x-mixed-replace; boundary="quoted"')).toBe('quoted')
  })

  it('answers nothing when there is no boundary to read', () => {
    expect(boundaryOf('image/jpeg')).toBeNull()
    expect(boundaryOf(null)).toBeNull()
  })
})

describe('frameParser', () => {
  it('hands back each frame whole, in order', () => {
    const parser = frameParser('b')
    const frames = parser.push(concat(part('b', bytes(1, 2, 3)), part('b', bytes(4, 5))))

    expect(frames).toHaveLength(2)
    expect(Array.from(frames[0]!)).toEqual([1, 2, 3])
    expect(Array.from(frames[1]!)).toEqual([4, 5])
  })

  it('holds a frame until its last byte has arrived, split however it comes', () => {
    const parser = frameParser('b')
    const stream = concat(part('b', bytes(9, 8, 7, 6)), part('b', bytes(5)))

    const frames: Uint8Array[] = []
    for (const byte of stream) frames.push(...parser.push(bytes(byte)))

    expect(frames).toHaveLength(2)
    expect(Array.from(frames[0]!)).toEqual([9, 8, 7, 6])
    expect(Array.from(frames[1]!)).toEqual([5])
  })

  it('reads a frame by its length, so boundary bytes inside one do not split it', () => {
    const parser = frameParser('b')
    // The payload itself contains `--b`, which a naive split would divide on.
    const frames = parser.push(part('b', encoder.encode('--b not a real boundary')))

    expect(frames).toHaveLength(1)
    expect(new TextDecoder().decode(frames[0]!)).toBe('--b not a real boundary')
  })

  it('skips a part that does not name its length rather than desyncing the rest', () => {
    const parser = frameParser('b')
    const broken = encoder.encode('--b\r\ncontent-type: image/jpeg\r\n\r\nunlabelled')
    const frames = parser.push(concat(broken, part('b', bytes(42))))

    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0]!)).toEqual([42])
  })

  it('gives nothing back while only part of a frame is in hand', () => {
    const parser = frameParser('b')
    const head = encoder.encode('--b\r\ncontent-type: image/jpeg\r\ncontent-length: 4\r\n\r\n')

    expect(parser.push(concat(head, bytes(1, 2, 3)))).toEqual([])
    expect(parser.push(bytes(4))).toHaveLength(1)
  })
})
