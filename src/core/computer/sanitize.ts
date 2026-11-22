import type { Message } from '../providers/types.js'
import { isComputerToolName } from './tools.js'

/**
 * Redacts desktop-derived tool arguments before writing to session files,
 * history logs, exports, or execution traces. Live approval prompts still
 * receive the full unredacted summary before this runs.
 */
export function sanitizeToolArgsForPersistence(name: string, args: unknown): unknown {
  if (!isComputerToolName(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
    return args
  }
  const record = args as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('__')) continue
    if (name === 'computer_act' && key === 'text' && typeof value === 'string') {
      out.text = `[redacted, ${value.length} chars]`
      continue
    }
    if (name === 'computer_list' && key === 'query' && typeof value === 'string') {
      out.query = '[redacted]'
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Returns a non-mutating projection of `messages` safe to write to disk at any
 * point (including mid-turn steering, cancellation, or error paths).
 *
 * Raw desktop screenshots and accessibility trees stay in live model context
 * during the turn, while every persisted copy carries only short summaries and
 * redacted desktop-derived tool arguments.
 */
export function sanitizeMessagesForPersistence(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    let changed = false
    const content = message.content.map((part) => {
      if (part.type === 'tool-call' && isComputerToolName(part.name)) {
        changed = true
        return { ...part, args: sanitizeToolArgsForPersistence(part.name, part.args) }
      }
      if (part.type === 'tool-result') {
        if (part.persistedContent !== undefined) {
          changed = true
          const { persistedContent, images: _images, ...rest } = part
          return { ...rest, content: persistedContent }
        }
        if (part.images?.some((image) => Boolean(image.inlineData))) {
          changed = true
          const kept = part.images.filter((image) => !image.inlineData)
          const { images: _images, ...rest } = part
          return kept.length > 0 ? { ...rest, images: kept } : rest
        }
      }
      return part
    })
    return changed ? { ...message, content } : message
  })
}
