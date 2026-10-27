import type { GenUiRender } from '../../core/genui.js'
import type { Idea } from '../../core/ideas.js'
import type { RoutineDelivery } from '../../core/outgoing.js'
import type { PanelRequest } from '../../core/panel.js'
import type { ProjectView } from '../../core/projects.js'
import type { TodoItem } from '../../core/todos.js'
import type { FileChange } from '../../core/change.js'
import type { VerificationResult } from '../../core/verification.js'
import { CLIENT_KINDS, type ClientKind } from '../../core/client.js'
import type { CommandEntry } from '../command-catalog.js'

// 13: a session too large for one websocket message hands its transcript over in
// pieces — the first in `ready`, the rest as `history` frames. The phone cannot take a
// message over 1 MiB (`URLSessionWebSocketTask` closes the socket with "Message too
// long"), so a session with a couple of large tool results never opened there at all.
// A client from 12 knows none of these frames and would draw only the first chunk, so
// it is refused rather than shown a session that is missing its middle.
// 12: a routine's delivery carries its own `routine` mark — the name and the instant
// it landed — instead of leading its text with the name, and a message read back from
// disk carries it too. A page from 11 would draw that delivery as a plain answer with
// no signer at all, so it is refused as a skew.
// 11: the turn's own row is drawn from the daemon's words — `says` on an `event` frame and
// on a `turn-end` — rather than from a sentence each client wrote for itself. A page from
// 10 writes its own, so it neither needs nor reads the field; the bump is what keeps a page
// that reads it from pairing with a daemon that does not send it and drawing no status at
// all. 10: the gateway's chat is `chatId`, not `conversationId`, in the handshake and in a
// routine's target. A page from 9 would name a field this daemon no longer reads, and
// a routine made from it would lose the chat it delivers to — so it is refused as a
// skew instead. 9: a `ui` event carries `draft` while the block is still being written,
// so the widget fills in as the tree arrives. A page from 8 would drop the flag and
// draw every draft as a finished widget, one under another, so it is refused — which
// is what the version is for. 8 made the handshake's `genui` a flag again: there is
// one way a turn draws, so a page naming a transport named something that no longer
// exists.
export const PROTOCOL_VERSION = 13
export const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000

/**
 * What the surface says when a plan is approved. The surface only sends the
 * `approve-plan` control; the daemon owns the words, so the turn that executes
 * the plan reads the same on the browser and on the phone.
 */
export const PLAN_APPROVAL = 'The plan is approved. Execute it.'

/**
 * What a page is told when the protocol it speaks is not the server's. One sentence,
 * said here, so the page, the server and the test that reads a refusal word for word
 * are all reading the same one.
 */
export function protocolRefusal(clientVersion: number): string {
  return `This client speaks protocol ${clientVersion} and this server speaks ${PROTOCOL_VERSION}. Update the client, or restart the server, and reconnect.`
}

/**
 * The protocol number a handshake names, read from the raw frame. A frame's own
 * shape can change with the version, so the skew has to be recognized before the
 * frame is parsed: a client from an older protocol must be told to update, not
 * answered as unreadable.
 */
export function helloVersion(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const frame = value as Record<string, unknown>
  return frame.type === 'hello' && typeof frame.version === 'number' ? frame.version : undefined
}

export const PERMISSION_MODES = ['ask', 'auto', 'yolo'] as const
export const CLASSIFIER_BACKENDS = ['commandcode', 'openai', 'openrouter', 'ollaya', 'custom'] as const
export const TOOL_LEVELS = ['full', 'name', 'off'] as const
export const THINKING_LEVELS = ['expanded', 'collapsed'] as const
/** How a surface draws a thought: open under the question, or folded there. */
export type ThinkingDisplay = (typeof THINKING_LEVELS)[number]
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
  | { type: 'tool-start'; id: string; name: string; args: unknown; text?: string }
  | { type: 'tool-end'; id: string; name: string; result: string; isError: boolean; drawFailure?: boolean; change?: FileChange[] }
  | { type: 'todo'; items: TodoItem[] }
  | { type: 'panel'; request: PanelRequest }
  | { type: 'ui'; render: GenUiRender; draft?: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'compacting' }
  | { type: 'compacted'; ms: number; folded: number; tokens: number; summarized: boolean }
  | { type: 'rebased'; added: number; removed: number; compacted: boolean }
  | { type: 'waiting' }
  | { type: 'waited'; ms: number }
  | { type: 'steer'; text: string }
  /** The project's own checks after a turn that wrote. Display state only. */
  | { type: 'verification'; result: VerificationResult; text: string; ok: boolean }
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
  chatId: string
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

/**
 * Every control a screen may send, declared once: the frame's own type reads it and
 * so does the parser. Two spellings of one vocabulary is how `always` — the button
 * every surface draws — came to be refused by the parser while the type promised it.
 */
const CONTROL_ACTIONS = ['stop', 'allow', 'always', 'deny', 'plan', 'approve-plan'] as const

export type ClientFrame =
  | { type: 'hello'; version: number; chatId: string; genui?: boolean; client?: ClientKind }
  | { type: 'send'; text: string; intent?: 'steer' | 'queue'; target?: SendTarget; uploadIds?: string[] }
  | {
      type: 'control'
      /** `always`: allow, and for this session do not ask again about the same act. */
      action: (typeof CONTROL_ACTIONS)[number]
      id?: string
      plan?: boolean
    }
  /** Stop a background job. Pressing the control is the confirmation. */
  | { type: 'job-kill'; id: string }
  | { type: 'command'; text: string }
  | { type: 'action'; actionId: string; messageId?: string }
  /** Pointer/keyboard the person sent into the live browser panel. */
  | { type: 'panel-input'; input: PanelInput }
  /** Bring a panel tab to the front, or close it, named by its key. */
  | { type: 'panel-activate'; key: string }
  | { type: 'panel-close'; key: string }

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

/**
 * What a panel is showing, once the server has resolved the model's request. The
 * bytes stay on disk: an artifact the panel draws is served inline from
 * `/panel/<id>`, so only a descriptor travels here.
 *
 * A page is an HTML file, rendered live in a frame.
 */
export type PanelKind = 'document' | 'page' | 'image' | 'pdf' | 'file' | 'browser'

export interface PanelState {
  kind: PanelKind
  title?: string
  /** The file behind 'document', 'page', 'image', 'pdf' or 'file'. */
  artifact?: FrameAttachment
  /** For 'browser': the page it is on, when known. */
  url?: string | null
}

/**
 * One tab of the panel: a view, plus the stable name a click refers to it by.
 * The key is the browser's own, or the artifact id (a hash of the path), so it
 * survives a reload — and a click names a tab rather than a position, which would
 * race the list shifting under it.
 */
export type PanelTab = PanelState & { key: string }

/**
 * What the panel beside a chat is showing: its tabs, in the order they opened,
 * and the one in front. `null` wherever a view is carried means nothing is open.
 */
export interface PanelView {
  tabs: PanelTab[]
  active: number
}

/**
 * A background job as the page draws it in the strip above the composer. Only
 * what the strip needs: what it is running, since when, and the tail of what it
 * has printed — the full log stays on the machine.
 */
export interface JobView {
  id: string
  command: string
  startedAt: number
  lines: string[]
}

/**
 * Pointer and keyboard the person sends into the live browser panel. Coordinates
 * are normalized to the viewport (0..1) so the page does not have to know its
 * pixel size, and the browser maps them back. A key carries CDP's modifier
 * bitmask (Alt 1, Ctrl 2, Meta 4, Shift 8) so a shortcut is not mistaken for a
 * plain character.
 */
export type PanelInput =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'scroll'; x: number; y: number; deltaY: number }
  | { kind: 'key'; key: string; modifiers?: number }
  | { kind: 'type'; text: string }

/**
 * A turn that is still being written when a client arrives. Its own `turn-start`
 * went out before this client was listening, and the session on disk is only written
 * a step at a time — so the middle of an answer is nowhere: neither in the transcript
 * nor on the wire. The daemon hands back the id the turn is drawn under, and the
 * events it has already said follow, in order, right after the `ready`.
 *
 * Additive, like the handshake's `client`: a client that does not know the field
 * draws nothing of the turn and is no worse off than before, and a server that does
 * not send it is the one that never had it.
 */
export interface ActiveTurn {
  id: string
  /** When the turn began, for a surface that says when a message was said. No
   *  thinking time rides with it: this client did not watch the turn think. */
  at: number
}

export type ServerFrame =
  | { type: 'ready'; version: number; sessionId: string; messages: TranscriptMessage[]; continues?: boolean; thinking: ThinkingDisplay; provider: string; providerName: string; model: string; effort?: 'low' | 'medium' | 'high'; panel?: PanelView | null; jobs?: JobView[]; activeTurn?: ActiveTurn; project?: ProjectView; plan?: boolean; commands?: CommandEntry[] }
  /**
   * The rest of a transcript too large for the `ready` alone, in order, each one whole
   * rows. A surface appends them to the thread the `ready` opened — before the running
   * turn's own row when there is one, so the turn keeps its place at the end. The last
   * one is the end of the replay.
   */
  | { type: 'history'; messages: TranscriptMessage[] }
  /** The session's planning turn went on or off, for every screen watching it. */
  | { type: 'plan'; plan: boolean }
  | { type: 'turn-start'; id: string; text: string }
  /**
   * A step of the turn. `says` is what the turn's own row shows about the step, in the
   * daemon's words (`statusText` in `src/core/sessions/format.ts`): a surface that cannot
   * import that reads the sentence here rather than writing it again, the way the tool
   * line's `text` is read. Absent where the step says nothing about the row.
   */
  | { type: 'event'; turnId: string; event: AgentEvent; says?: string }
  | { type: 'permission'; id: string; request: PermissionRequest; expiresAt: number }
  | { type: 'permission-result'; id: string; allowed: boolean; remember?: boolean }
  /** `says` says a stopped turn the same way an event does; see the `event` frame. */
  | { type: 'turn-end'; id: string; status: 'done' | 'stopped' | 'error'; raw?: string; rawNoOutput?: string; says?: string }
  | { type: 'command-result'; reply: string; markdown?: string; sessionId?: string; attachments?: FrameAttachment[]; actions?: ActionRow[]; messageId?: string; cards?: SessionCardItem[]; routine?: RoutineDelivery }
  | { type: 'state'; busy: boolean; queued: number }
  /** A routine ran somewhere in this install: re-read whatever shows the history. */
  | { type: 'routines-changed' }
  /** A session's turn began or ended here: re-read the list that shows it running. */
  | { type: 'sessions-changed' }
  /**
   * A step finished that may have changed what is on disk — a file written, a command run
   * — somewhere in this install. Not the same news as `sessions-changed`: that one is about
   * which session is running, this one is about the folder a session works in. A screen
   * drawing a folder re-reads it on this, so a long turn is followed as it happens.
   *
   * Carries nothing, and is throttled by the daemon: a turn makes a step a second, and each
   * one costs a screen a tree and a diff. Only the screens drawing a folder act on it, and
   * the turn's own end says it once more, unthrottled, so the floor cannot leave a screen
   * showing the second-to-last state.
   */
  | { type: 'work-changed' }
  /** The panel beside the chat changed; null takes it down. */
  | { type: 'panel'; panel: PanelView | null }
  /** The background jobs still running, for the strip above the composer. */
  | { type: 'jobs'; jobs: JobView[] }
  /**
   * Ideas for the empty home, from what Milo knows. They arrive after the page is
   * already showing the standing four, which they take the place of.
   */
  | { type: 'suggestions'; items: Idea[] }
  | { type: 'error'; message: string }

/**
 * How far along a call is, as the line beside it draws it. Unset where a stored
 * call has no result beside it — a turn cut short mid-call did not finish, and
 * saying either way would be a guess.
 */
export type ToolState = 'running' | 'done' | 'failed'

/**
 * A tool call as a surface draws it. The words and the icon travel apart because
 * only one of them is a character: a chat client pastes the emoji into the line,
 * and the browser draws the service's mark beside it.
 */
export interface ToolMark {
  name: string
  text: string
  state?: ToolState
  /**
   * What the call came back with, for the detail under its line — capped where the live
   * turn and a read-back both build it, so the two draw the same thing. Absent rather than
   * empty where there is nothing to show (a call still running, a level below `full`, a
   * result that was only whitespace); the whole of it stays in the turn's raw copy.
   */
  result?: string
  /**
   * What the call changed in the files, for the detail under its line: the same
   * gate as `result` — a level below `full` asked for less than this. Absent
   * where the call wrote nothing.
   */
  change?: FileChange[]
}

/** One piece of a turn as the page draws it, in the order it happened. */
export type TranscriptPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; tool: ToolMark }
  | { kind: 'todo'; items: TodoItem[] }
  /** What the project's checks answered after the turn. */
  | { kind: 'verification'; ok: boolean; text: string }
  /** `draft` is only ever set on the wire: a stored session is read back as it ended. */
  | { kind: 'ui'; render: GenUiRender; draft?: boolean }

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  /** The turn's pieces — prose, thinking, tool lines and the plan — in order. */
  parts: TranscriptPart[]
  /**
   * A message a routine delivered into this conversation, when this is one: its
   * name and the instant it landed. The surface signs the message with it instead
   * of drawing an answer nobody in the chat asked for.
   */
  routine?: RoutineDelivery
  /** Files delivered into this conversation, still on disk and served by id. */
  attachments?: FrameAttachment[]
  /** When the message was first said, for a surface that shows it. */
  at?: number
  /** How long the turn took to say anything, for the line over its thought. */
  thoughtMs?: number
  /**
   * The turn copied whole — the model's words (a `genui` block among them, in its own
   * JSON), its thinking, and every tool call with its arguments and result — for a
   * surface's "copy raw". Rendered on the server because the parts above are drawn
   * forms that leave the arguments and the results out. Absent on a turn that is only
   * prose, and on a person's own message, where the words are the whole of it.
   */
  raw?: string
  /**
   * The same turn with the tool results' own text left out — the path it walked: every
   * call still named, a failed one still said — the other choice under the same copy.
   * Absent when it would read word for word as `raw` (a turn with no result to leave
   * out), so a second copy that repeats the first is never offered.
   */
  rawNoOutput?: string
}

/** The words of a message, everything that is not prose left out. */
export function proseOf(message: { parts: TranscriptPart[] }): string {
  return message.parts
    .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
    .map((part) => part.text)
    .join('\n\n')
}

/**
 * How much of a session's history one websocket message may carry. The phone's
 * `URLSessionWebSocketTask` refuses a message over 1 MiB — "Message too long" — and
 * closes the socket, so a session with a couple of large tool results reconnected in
 * a loop and never opened there. A chunk this size leaves room for the frame around
 * it and stays a fraction of that ceiling.
 */
export const TRANSCRIPT_CHUNK_BYTES = 256 * 1024

/**
 * A transcript in pieces a websocket message can hold, whole rows at a time: a split
 * inside a row would hand a surface half a tool result with nothing saying it was cut.
 * A row larger than the budget goes alone rather than being divided — it cannot be
 * made smaller here, and a surface that cannot take it is the one to say so.
 */
export function transcriptChunks(
  messages: TranscriptMessage[],
  budget = TRANSCRIPT_CHUNK_BYTES,
): TranscriptMessage[][] {
  const chunks: TranscriptMessage[][] = []
  let chunk: TranscriptMessage[] = []
  let size = 0
  for (const message of messages) {
    const length = JSON.stringify(message).length
    if (chunk.length > 0 && size + length > budget) {
      chunks.push(chunk)
      chunk = []
      size = 0
    }
    chunk.push(message)
    size += length
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

export function parseClientFrame(value: unknown): ClientFrame | null {
  if (!value || typeof value !== 'object') return null
  const frame = value as Record<string, unknown>
  if (frame.type === 'hello' && typeof frame.chatId === 'string' && typeof frame.version === 'number' && (frame.genui === undefined || typeof frame.genui === 'boolean') && (frame.client === undefined || (CLIENT_KINDS as readonly string[]).includes(String(frame.client)))) {
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
  if (frame.type === 'control') {
    if (frame.action === 'plan') {
      return typeof frame.plan === 'boolean' ? (frame as ClientFrame) : null
    }
    if (frame.action === 'approve-plan') return frame as ClientFrame
    if ((CONTROL_ACTIONS as readonly string[]).includes(String(frame.action))) return frame as ClientFrame
  }
  if (frame.type === 'job-kill' && typeof frame.id === 'string' && frame.id !== '') {
    return frame as ClientFrame
  }
  if (frame.type === 'command' && typeof frame.text === 'string') return frame as ClientFrame
  if (frame.type === 'panel-input' && isPanelInput(frame.input)) return frame as ClientFrame
  if ((frame.type === 'panel-activate' || frame.type === 'panel-close') && typeof frame.key === 'string' && frame.key !== '') {
    return frame as ClientFrame
  }
  if (frame.type === 'action' && typeof frame.actionId === 'string' && (frame.messageId === undefined || typeof frame.messageId === 'string')) {
    return frame as ClientFrame
  }
  return null
}

/** A pointer/keyboard event from the live browser panel, checked rather than trusted. */
function isPanelInput(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  const point = (key: string): boolean => typeof input[key] === 'number' && Number.isFinite(input[key])
  if (input.kind === 'key') {
    return typeof input.key === 'string' && input.key.trim() !== ''
      && (input.modifiers === undefined
        || (typeof input.modifiers === 'number' && Number.isInteger(input.modifiers) && input.modifiers >= 0 && input.modifiers <= 15))
  }
  if (input.kind === 'type') return typeof input.text === 'string'
  if (input.kind === 'scroll') return point('x') && point('y') && point('deltaY')
  if (input.kind === 'click' || input.kind === 'move') return point('x') && point('y')
  return false
}

/**
 * Half a target is not one — the same rule the routine tool applies to its own
 * arguments, because guessing the other half is how a routine goes quiet.
 */
function isSendTarget(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const target = value as Record<string, unknown>
  return (TARGET_GATEWAYS as readonly string[]).includes(String(target.gateway))
    && typeof target.chatId === 'string'
    && target.chatId.trim() !== ''
}
