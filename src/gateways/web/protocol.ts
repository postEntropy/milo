export const PROTOCOL_VERSION = 1
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

export const PERMISSION_MODES = ['ask', 'auto', 'yolo'] as const
export const TOOL_LEVELS = ['full', 'name', 'off'] as const
export const THINKING_LEVELS = ['on', 'off'] as const
export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const
export const SEARCH_PROVIDERS = ['off', 'tavily', 'exa', 'parallel'] as const

export interface PermissionRequest {
  tool: string
  args: unknown
  summary: string
}

export type AgentEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-start'; id: string; name: string; args: unknown }
  | { type: 'tool-end'; id: string; name: string; result: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'compacted'; ms: number }
  | { type: 'rebased'; added: number; compacted: boolean }
  | { type: 'waiting' }
  | { type: 'waited'; ms: number }
  | { type: 'steer'; text: string }
  | { type: 'done'; finishReason: string }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

export type ClientFrame =
  | { type: 'hello'; version: number; conversationId: string }
  | { type: 'send'; text: string; intent?: 'steer' | 'queue' }
  | { type: 'control'; action: 'stop' | 'allow' | 'deny'; id?: string }
  | { type: 'command'; text: string }

/**
 * A file that has been delivered into a conversation. The browser never sees a
 * path: it asks the server for `id`, and only files it has delivered are served.
 * `image` is decided here so the page does not have to know MIME types.
 */
export interface FrameAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  image: boolean
}

export type ServerFrame =
  | { type: 'ready'; version: number; sessionId: string; messages: TranscriptMessage[]; thinking: 'on' | 'off'; provider: string; model: string }
  | { type: 'turn-start'; id: string; text: string }
  | { type: 'event'; turnId: string; event: AgentEvent }
  | { type: 'permission'; id: string; request: PermissionRequest; expiresAt: number }
  | { type: 'permission-result'; id: string; allowed: boolean }
  | { type: 'turn-end'; id: string; status: 'done' | 'stopped' | 'error' }
  | { type: 'command-result'; reply: string; markdown?: string; sessionId?: string; attachments?: FrameAttachment[] }
  | { type: 'state'; busy: boolean; queued: number }
  | { type: 'error'; message: string }

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  reasoning?: string
  /** The tool calls this turn made, one line each, in the shared chat format. */
  tools?: string[]
  /** Files delivered into this conversation, still on disk and served by id. */
  attachments?: FrameAttachment[]
}

export function parseClientFrame(value: unknown): ClientFrame | null {
  if (!value || typeof value !== 'object') return null
  const frame = value as Record<string, unknown>
  if (frame.type === 'hello' && typeof frame.conversationId === 'string' && typeof frame.version === 'number') {
    return frame as ClientFrame
  }
  if (frame.type === 'send' && typeof frame.text === 'string' && (frame.intent === undefined || frame.intent === 'steer' || frame.intent === 'queue')) {
    return frame as ClientFrame
  }
  if (frame.type === 'control' && ['stop', 'allow', 'deny'].includes(String(frame.action))) {
    return frame as ClientFrame
  }
  if (frame.type === 'command' && typeof frame.text === 'string') return frame as ClientFrame
  return null
}
