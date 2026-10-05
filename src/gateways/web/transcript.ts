import type { OutgoingFile } from '../../core/outgoing.js'
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
