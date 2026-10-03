export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextPart {
  type: 'text'
  text: string
}

/** An image attached to an incoming user message. Bytes stay outside session files. */
export interface ImagePart {
  type: 'image'
  mimeType: ImageMime
  path: string
  name: string
}

/** An audio attachment kept beside the transcript and sent inline to capable models. */
export interface AudioPart {
  type: 'audio'
  mimeType: string
  path: string
  name: string
}

/**
 * What the model thought before answering. It is kept with the transcript so a
 * session read back later still shows how the answer was reached, and it is not
 * part of the conversation the model is sent back — with one exception: the
 * Anthropic wire signs its thinking blocks and requires them echoed with every
 * follow-up request once thinking is on, so a part carrying a `signature` is
 * replayed as one, and any part without a signature is dropped on the way out.
 */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  /**
   * The provider's signature over this thought, when it gave one. Only the
   * Anthropic wire has one, and a thinking block is only replayable with it.
   */
  signature?: string
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

/**
 * A file delivered to this conversation out of band — a routine's picture or
 * document, kept so a chat read back later still shows it. It is not sent to the
 * model: the wires here build their blocks from the known part types and skip
 * this one, so what the person received is on the transcript without costing a
 * token on every request that follows.
 */
export interface FilePart {
  type: 'file'
  path: string
  name: string
  mimeType: string
}

export type ContentPart = TextPart | ImagePart | AudioPart | ReasoningPart | ToolCallPart | ToolResultPart | FilePart

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
  /**
   * How many tokens the Anthropic wire may spend thinking before answering.
   * Absent means thinking is off on that wire — a mechanical call leaves it
   * absent, so it pays no reasoning tax. The OpenAI wire ignores this and reads
   * `reasoningEffort` instead.
   */
  thinkingBudget?: number
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'reasoning-signature'; signature: string }
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
