export interface SSEMessage {
  event?: string
  data: string
}

/**
 * Parses a `text/event-stream` body into individual messages. Yields each
 * `data:` payload together with the `event:` name that precedes it (used by
 * the Anthropic wire).
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined

  const flushLine = (rawLine: string): SSEMessage | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      eventName = undefined
      return undefined
    }
    if (line.startsWith(':')) return undefined
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      return undefined
    }
    if (line.startsWith('data:')) {
      const data = line.slice(5).replace(/^ /, '')
      return { event: eventName, data }
    }
    return undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        const message = flushLine(line)
        if (message) yield message
      }
    }
    buffer += decoder.decode()
    for (const line of buffer.split('\n')) {
      const message = flushLine(line)
      if (message) yield message
    }
  } finally {
    reader.releaseLock()
  }
}
