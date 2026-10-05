import type { Idea } from '../../core/ideas.js'
import type { TodoItem } from '../../core/todos.js'

export const PROTOCOL_VERSION = 2
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

export const PERMISSION_MODES = ['ask', 'auto', 'yolo'] as const
export const CLASSIFIER_BACKENDS = ['commandcode', 'ollaya', 'custom'] as const
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
  | { type: 'todo'; items: TodoItem[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'compacted'; ms: number }
  | { type: 'rebased'; added: number; compacted: boolean }
  | { type: 'waiting' }
  | { type: 'waited'; ms: number }
  | { type: 'steer'; text: string }
  | { type: 'done'; finishReason: string }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

/**
 * The chat a screen is addressing, when it is not the one the turn came from. A
 * routine made from the routines screen is pinned to the destination that screen
 * chose, so the model does not have to infer it from the sentence.
 */
export interface SendTarget {
  gateway: 'telegram' | 'discord' | 'web' | 'none'
  conversationId: string
}

const TARGET_GATEWAYS = ['telegram', 'discord', 'web', 'none'] as const

export type ActionButtonStyle = 'default' | 'primary' | 'danger' | 'success'

export interface ActionButton {
  id: string
  label: string
  style?: ActionButtonStyle
  url?: string
  disabled?: boolean
}

export type ActionRow = ActionButton[]

export interface SessionCardItem {
  id: string
  title?: string
  messageCount: number
  when: string
  summary: string
}

export type ClientFrame =
  | { type: 'hello'; version: number; conversationId: string }
  | { type: 'send'; text: string; intent?: 'steer' | 'queue'; target?: SendTarget; uploadIds?: string[] }
  | { type: 'control'; action: 'stop' | 'allow' | 'deny'; id?: string }
  | { type: 'command'; text: string }
  | { type: 'action'; actionId: string; messageId?: string }

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
  | { type: 'ready'; version: number; sessionId: string; messages: TranscriptMessage[]; thinking: 'on' | 'off'; provider: string; providerName: string; model: string; effort?: 'low' | 'medium' | 'high' }
  | { type: 'turn-start'; id: string; text: string }
  | { type: 'event'; turnId: string; event: AgentEvent }
  | { type: 'permission'; id: string; request: PermissionRequest; expiresAt: number }
  | { type: 'permission-result'; id: string; allowed: boolean }
  | { type: 'turn-end'; id: string; status: 'done' | 'stopped' | 'error' }
  | { type: 'command-result'; reply: string; markdown?: string; sessionId?: string; attachments?: FrameAttachment[]; actions?: ActionRow[]; messageId?: string; cards?: SessionCardItem[] }
  | { type: 'state'; busy: boolean; queued: number }
  /** A routine ran somewhere in this install: re-read whatever shows the history. */
  | { type: 'routines-changed' }
  /**
   * Ideas for the empty home, from what Milo knows. They arrive after the page is
   * already showing the standing four, which they take the place of.
   */
  | { type: 'suggestions'; items: Idea[] }
  | { type: 'error'; message: string }

/**
 * A tool call as a surface draws it. The words and the icon travel apart because
 * only one of them is a character: a chat client pastes the emoji into the line,
 * and the browser draws the service's mark beside it.
 */
export interface ToolMark {
  name: string
  text: string
}

/** One piece of a turn as the page draws it, in the order it happened. */
export type TranscriptPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; tool: ToolMark }
  | { kind: 'todo'; items: TodoItem[] }

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  /** The turn's pieces — prose, thinking, tool lines and the plan — in order. */
  parts: TranscriptPart[]
  /** Files delivered into this conversation, still on disk and served by id. */
  attachments?: FrameAttachment[]
}

/** The words of a message, everything that is not prose left out. */
export function proseOf(message: { parts: TranscriptPart[] }): string {
  return message.parts
    .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

export function parseClientFrame(value: unknown): ClientFrame | null {
  if (!value || typeof value !== 'object') return null
  const frame = value as Record<string, unknown>
  if (frame.type === 'hello' && typeof frame.conversationId === 'string' && typeof frame.version === 'number') {
    return frame as ClientFrame
  }
  if (
    frame.type === 'send' &&
    typeof frame.text === 'string' &&
    (frame.uploadIds === undefined || (Array.isArray(frame.uploadIds) && frame.uploadIds.every((id) => typeof id === 'string'))) &&
    (frame.intent === undefined || frame.intent === 'steer' || frame.intent === 'queue') &&
    (frame.target === undefined || isSendTarget(frame.target))
  ) {
    return frame as ClientFrame
  }
  if (frame.type === 'control' && ['stop', 'allow', 'deny'].includes(String(frame.action))) {
    return frame as ClientFrame
  }
  if (frame.type === 'command' && typeof frame.text === 'string') return frame as ClientFrame
  if (frame.type === 'action' && typeof frame.actionId === 'string' && (frame.messageId === undefined || typeof frame.messageId === 'string')) {
    return frame as ClientFrame
  }
  return null
}

/**
 * Half a target is not one — the same rule the routine tool applies to its own
 * arguments, because guessing the other half is how a routine goes quiet.
 */
function isSendTarget(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const target = value as Record<string, unknown>
  return (TARGET_GATEWAYS as readonly string[]).includes(String(target.gateway))
    && typeof target.conversationId === 'string'
    && target.conversationId.trim() !== ''
}
