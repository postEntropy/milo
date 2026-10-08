import type { OutgoingFile } from '../../core/outgoing.js'
import type { PanelRequest } from '../../core/panel.js'
import type { Message } from '../../core/providers/types.js'
import { todosFromArgs } from '../../core/todos.js'
import { showsToolCall, toolText } from '../tool-line.js'
import type { FrameAttachment, TranscriptMessage, TranscriptPart } from './protocol.js'

/** Notes a file a transcript drew and describes it for the browser. */
export type RegisterFile = (file: OutgoingFile) => FrameAttachment

/**
 * A session's history as the page renders it. The one place a transcript is
 * turned into frames, shared by the live socket and by the read-only view of a
 * past routine run — so the two cannot draw the same turn differently.
 *
 * Reading a file re-registers it, so a delivered picture is served again after a
 * reload without anything being kept in memory across restarts.
 *
 * Prose, thinking, tool lines and the plan keep the order they happened in: the
 * page draws a turn step by step, the way every other surface does.
 */
export function transcriptOf(messages: Message[], register: RegisterFile): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  let currentAssistant: TranscriptMessage | null = null

  for (const message of messages) {
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    if (message.role === 'user') {
      currentAssistant = null
      const attachments = message.content.flatMap((part) => part.type === 'image'
        ? [register({ path: part.path, name: part.name, mimeType: part.mimeType })]
        : [])
      if (text || attachments.length) {
        transcript.push({ role: 'user', parts: text ? [{ kind: 'text', text }] : [], ...(attachments.length ? { attachments } : {}) })
      }
      continue
    }
    if (message.role === 'assistant') {
      const parts: TranscriptPart[] = []
      const attachments = message.content.flatMap((part) => part.type === 'file'
        ? [register({ path: part.path, name: part.name, mimeType: part.mimeType })]
        : [])
      // Walked in order, so a tool line lands between the prose around it. The
      // plan rides on the `todo` call's own arguments, so it survives a reload
      // the way any other part of the transcript does.
      for (const part of message.content) {
        if (part.type === 'reasoning' && part.text) parts.push({ kind: 'reasoning', text: part.text })
        else if (part.type === 'text' && part.text) parts.push({ kind: 'text', text: part.text })
        else if (part.type === 'tool-call') {
          const todos = todosFromArgs(part.args)
          if (todos.length > 0) parts.push({ kind: 'todo', items: todos })
          if (showsToolCall(part.name)) parts.push({ kind: 'tool', tool: { name: part.name, text: toolText(part.name, part.args) } })
        }
      }

      if (!currentAssistant) {
        currentAssistant = {
          role: 'assistant',
          parts,
          ...(attachments.length > 0 ? { attachments } : {}),
        }
        transcript.push(currentAssistant)
      } else {
        if (parts.length > 0) currentAssistant.parts.push(...parts)
        if (attachments.length > 0) currentAssistant.attachments = [...(currentAssistant.attachments ?? []), ...attachments]
      }
    }
  }

  return transcript.filter((message) => message.parts.length > 0 || (message.attachments?.length ?? 0) > 0)
}

/**
 * The panel out of a session's history: every request a `panel` call made, in the
 * order it was made, so a reload replays what was open — the same requests, run
 * through the same rule, that put the tabs up live. Read from the tool-call
 * arguments the way the plan is — a transcript read back from disk is checked,
 * not trusted — and a path is left as written; the caller resolves it against the
 * working directory, which is the only place that knows it.
 */
export function panelsOf(messages: Message[]): PanelRequest[] {
  const requests: PanelRequest[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.name !== 'panel') continue
      const request = panelRequestFromArgs(part.args)
      if (request) requests.push(request)
    }
  }
  return requests
}

function panelRequestFromArgs(args: unknown): PanelRequest | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  const request: PanelRequest = {}
  if (typeof record.path === 'string' && record.path.trim()) request.path = record.path.trim()
  if (record.browser === true) request.browser = true
  if (typeof record.title === 'string' && record.title.trim()) request.title = record.title.trim()
  if (record.action === 'close') request.close = true
  if (!request.path && !request.browser && !request.close) return null
  return request
}
