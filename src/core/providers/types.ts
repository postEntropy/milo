export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextPart {
  type: 'text'
  text: string
}

/**
 * What the model thought before answering. It is kept with the transcript so a
 * session read back later still shows how the answer was reached — and it is
 * deliberately never sent to a provider: it is not part of the conversation,
 * and replaying it would pay for the same tokens twice.
 */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
}

export interface ToolCallPart {
  type: 'tool-call'
  id: string
  name: string
  args: unknown
}

/** What every provider here accepts inline; anything else has to be converted first. */
export type ImageMime = 'image/png' | 'image/jpeg'

/**
 * A picture kept beside the transcript instead of inside it: the bytes live in
 * `~/.milo/images/` and the part carries the path. A screenshot is megabytes of
 * base64, and the session file is rewritten on every turn — inlining it would
 * make saving a session cost more than the model call that produced it.
 */
export interface ImageRef {
  mimeType: ImageMime
  path: string
}

export interface ToolResultPart {
  type: 'tool-result'
  id: string
  name: string
  content: string
  isError?: boolean
  /** Pictures to show the model with this result. The wires inline them from disk. */
  images?: ImageRef[]
}

export type ContentPart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart

export interface Message {
  role: Role
  content: ContentPart[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error'

/**
 * How hard a model is asked to think before answering. The values are the ones
 * the OpenAI wire names; a provider that does not know the field ignores it, and
 * one that rejects it fails loudly on the turn that asked for it.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/**
 * What Milo asks for when the config says nothing. It used to send nothing at
 * all and let each provider and model pick — a value nobody could name, which
 * made "default" a label you could not read. Medium is the one the OpenAI wire
 * itself documents, so it is the one every request carries now.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium'

export interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  system?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  /**
   * Absent means the provider's own default — what every request sent before
   * this existed. A mechanical call (summarizing, recapping) has no reason to
   * think hard, and a reasoning model's default will.
   */
  reasoningEffort?: ReasoningEffort
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: FinishReason }

export interface Provider {
  readonly id: string
  stream(req: ChatRequest): AsyncIterable<StreamEvent>
}

export function textMessage(role: Role, text: string): Message {
  return { role, content: [{ type: 'text', text }] }
}

export function textOf(message: Message): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

export function parseToolArgs(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return { __raw: raw }
  }
}
