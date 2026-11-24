import type { Message } from '../providers/types.js'
import { redactSecrets, redactSecretsInValue } from '../secrets.js'
import { isComputerToolName } from './tools.js'

/**
 * Redacts desktop-derived tool arguments and secrets before writing to session
 * files, history logs, exports, or execution traces. Live approval prompts
 * still receive the full unredacted summary before this runs.
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
 * during the turn, while every persisted copy carries only short summaries,
 * redacted secrets, and redacted desktop-derived tool arguments.
 */
export function sanitizeMessagesForPersistence(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    let changed = false
    let displayText = message.displayText
    if (typeof displayText === 'string') {
      const clean = redactSecrets(displayText)
      if (clean.redacted) {
        displayText = clean.text
        changed = true
      }
    }
    const content = message.content.map((part) => {
      if (part.type === 'text' || part.type === 'reasoning') {
        const clean = redactSecrets(part.text)
        if (clean.redacted) {
          changed = true
          return { ...part, text: clean.text }
        }
        return part
      }
      if (part.type === 'tool-call') {
        const nextArgs = isComputerToolName(part.name)
          ? sanitizeToolArgsForPersistence(part.name, part.args)
          : redactSecretsInValue(part.args)
        if (isComputerToolName(part.name) || nextArgs !== part.args) {
          changed = true
          return { ...part, args: nextArgs }
        }
        return part
      }
      if (part.type === 'tool-result') {
        if (part.persistedContent !== undefined) {
          changed = true
          const { persistedContent, images: _images, ...rest } = part
          return { ...rest, content: redactSecrets(persistedContent).text }
        }
        const cleanContent = typeof part.content === 'string' ? redactSecrets(part.content) : null
        const hasInline = part.images?.some((image) => Boolean(image.inlineData)) ?? false
        if (cleanContent?.redacted || hasInline) {
          changed = true
          const kept = hasInline ? part.images!.filter((image) => !image.inlineData) : part.images
          const { images: _images, ...rest } = part
          return {
            ...rest,
            ...(cleanContent ? { content: cleanContent.text } : {}),
            ...(kept && kept.length > 0 ? { images: kept } : {}),
          }
        }
      }
      return part
    })
    return changed
      ? { ...message, ...(displayText !== undefined ? { displayText } : {}), content }
      : message
  })
}
