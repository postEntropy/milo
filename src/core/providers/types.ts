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

export interface ToolResultPart {
  type: 'tool-result'
  id: string
  name: string
  content: string
  isError?: boolean
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

export interface ChatRequest {
  model: string
  messages: Message[]
  tools?: ToolSpec[]
  system?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
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
