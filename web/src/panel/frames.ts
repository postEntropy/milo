/**
 * The live browser arrives as one long `multipart/x-mixed-replace` response, each
 * part a JPEG. This reads it the way the server writes it — a boundary, a
 * `content-length`, then exactly that many bytes — so the panel knows a frame
 * landed the moment its bytes do. An `<img>` pointed at the same URL draws the
 * stream but never says when it stopped, which is what leaves a dropped stream
 * frozen on its last frame; parsing it here is what makes the stall visible.
 *
 * Pure and incremental: bytes are pushed in as they arrive, however they are
 * split, and a frame is handed back only once it is whole.
 */

export interface FrameParser {
  push(chunk: Uint8Array): Uint8Array<ArrayBuffer>[]
}

const CRLF = new Uint8Array([13, 10])
const HEADER_END = new Uint8Array([13, 10, 13, 10])

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const last = haystack.length - needle.length
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** The boundary named in a `multipart/x-mixed-replace; boundary=…` content type. */
export function boundaryOf(contentType: string | null | undefined): string | null {
  const match = /boundary="?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1] ?? null
}

/** The `content-length` of a part's headers, or null when it does not say. */
function contentLength(headers: string): number | null {
  const match = /content-length:\s*(\d+)/i.exec(headers)
  if (!match) return null
  const length = Number.parseInt(match[1]!, 10)
  return Number.isFinite(length) ? length : null
}

export function frameParser(boundary: string): FrameParser {
  const delimiter = new TextEncoder().encode(`--${boundary}`)
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0)

  return {
    push(chunk: Uint8Array): Uint8Array<ArrayBuffer>[] {
      if (chunk.length > 0) {
        const merged = new Uint8Array(buffer.length + chunk.length)
        merged.set(buffer, 0)
        merged.set(chunk, buffer.length)
        buffer = merged
      }
      const frames: Uint8Array<ArrayBuffer>[] = []
      for (;;) {
        const at = indexOf(buffer, delimiter, 0)
        if (at < 0) break
        const headerEnd = indexOf(buffer, HEADER_END, at + delimiter.length)
        if (headerEnd < 0) break
        const length = contentLength(new TextDecoder().decode(buffer.subarray(at + delimiter.length, headerEnd)))
        const bodyStart = headerEnd + HEADER_END.length
        // A part that does not name its length is skipped rather than guessed at,
        // so one malformed boundary cannot desync the rest of the stream.
        if (length === null) {
          buffer = buffer.subarray(at + delimiter.length)
          continue
        }
        if (buffer.length < bodyStart + length) break
        frames.push(buffer.slice(bodyStart, bodyStart + length))
        buffer = buffer.subarray(bodyStart + length)
        if (indexOf(buffer, CRLF, 0) === 0) buffer = buffer.subarray(CRLF.length)
      }
      return frames
    },
  }
}
