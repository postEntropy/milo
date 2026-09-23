import type { Message, Provider } from '../providers/types.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'

/** Rough token estimate. Cheap on purpose: no tokenizer, ~4 chars per token. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0
  for (const message of messages) {
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
          chars += part.text.length
          break
        case 'tool-result':
          chars += part.content.length
          break
        case 'tool-call':
          chars += part.name.length + safeJson(part.args).length
          break
      }
    }
  }
  return Math.ceil(chars / 4)
}

/** The same rough estimate for a plain string — a system prompt, say. */
export function estimateText(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Where to cut so the last `keepTurns` user turns survive.
 *
 * The cut always lands on a `user` message. That is what guarantees a tool call
 * is never separated from its result: the loop pushes the assistant's
 * `tool-call` and the matching `tool` result between two user messages.
 * Returns 0 when there is nothing safe to drop.
 */
export function planCut(messages: Message[], keepTurns: number): number {
  if (keepTurns <= 0) return 0
  const userIndexes: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user') userIndexes.push(index)
  })
  if (userIndexes.length <= keepTurns) return 0
  return userIndexes[userIndexes.length - keepTurns]!
}

export interface SummarizeOptions {
  provider: Provider
  model: string
  /** Summary of the turns dropped before these, to fold in. */
  previous?: string
  dropped: Message[]
  signal?: AbortSignal
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

const SUMMARY_SYSTEM = `You compress a conversation so it can continue with less context.
Write a dense summary of the transcript the user provides:
- facts, decisions and preferences that matter later;
- what was asked and what was concluded;
- any open threads or unfinished work.
Keep names, paths, commands and numbers exact. Write plain prose or short bullets,
in the language of the conversation. No preamble.`

/**
 * One model call that turns the dropped turns into a summary. Returns `null` on
 * any failure (or timeout), so the caller can fall back to dropping them plain.
 */
export async function summarize(options: SummarizeOptions): Promise<string | null> {
  const transcript = renderTranscript(options.dropped)
  if (!transcript.trim()) return null

  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  options.signal?.addEventListener('abort', abort, { once: true })

  let text = ''
  try {
    for await (const event of options.provider.stream({
      model: options.model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptFor(options.previous, transcript) }] }],
      signal: controller.signal,
    })) {
      if (event.type === 'text') text += event.delta
    }
  } catch (error) {
    logWarn(`summary failed, dropping the turns plain: ${errorMessage(error)}`)
    return null
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }

  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

function promptFor(previous: string | undefined, transcript: string): string {
  const parts: string[] = []
  if (previous?.trim()) {
    parts.push(`Summary so far:\n${previous.trim()}`)
  }
  parts.push(`New turns to fold in:\n\n${transcript}`)
  parts.push('Write the updated summary.')
  return parts.join('\n\n')
}

function renderTranscript(messages: Message[]): string {
  const lines: string[] = []
  for (const message of messages) {
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) {
      const speaker = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role
      lines.push(`${speaker}: ${text}`)
    }
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        lines.push(`Tool call: ${part.name}(${safeJson(part.args)})`)
      } else if (part.type === 'tool-result') {
        lines.push(`Tool result (${part.name}): ${truncate(part.content, 600)}`)
      }
    }
  }
  return lines.join('\n')
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function safeJson(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}
