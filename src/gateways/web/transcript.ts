import type { OutgoingFile } from '../../core/outgoing.js'
import type { Message } from '../../core/providers/types.js'
import { todosFromArgs } from '../../core/todos.js'
import { showsToolCall, toolText } from '../tool-line.js'
import type { FrameAttachment, TranscriptMessage } from './protocol.js'

/** Notes a file a transcript drew and describes it for the browser. */
export type RegisterFile = (file: OutgoingFile) => FrameAttachment

/**
 * A session's history as the page renders it. The one place a transcript is
 * turned into frames, shared by the live socket and by the read-only view of a
 * past routine run — so the two cannot draw the same turn differently.
 *
 * Reading a file re-registers it, so a delivered picture is served again after a
 * reload without anything being kept in memory across restarts.
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
      if (text || attachments.length) transcript.push({ role: 'user', text, ...(attachments.length ? { attachments } : {}) })
      continue
    }
    if (message.role === 'assistant') {
      const reasoning = message.content.filter((part) => part.type === 'reasoning').map((part) => part.text).join('')
      const tools = message.content.flatMap((part) =>
        part.type === 'tool-call' && showsToolCall(part.name)
          ? [{ name: part.name, text: toolText(part.name, part.args) }]
          : [],
      )
      // The plan rides on the `todo` call's own arguments, so it survives a
      // reload the way any other part of the transcript does.
      const todos = message.content.flatMap((part) => (part.type === 'tool-call' ? todosFromArgs(part.args) : []))

      const attachments = message.content.flatMap((part) =>
        part.type === 'file'
          ? [register({ path: part.path, name: part.name, mimeType: part.mimeType })]
          : [],
      )

      if (!currentAssistant) {
        currentAssistant = {
          role: 'assistant',
          text,
          ...(reasoning ? { reasoning } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(todos.length > 0 ? { todos } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        }
        transcript.push(currentAssistant)
      } else {
        if (text) {
          currentAssistant.text = currentAssistant.text ? `${currentAssistant.text}\n\n${text}` : text
        }
        if (reasoning) {
          currentAssistant.reasoning = currentAssistant.reasoning ? `${currentAssistant.reasoning}\n\n${reasoning}` : reasoning
        }
        if (tools.length > 0) {
          currentAssistant.tools = [...(currentAssistant.tools ?? []), ...tools]
        }
        if (todos.length > 0) {
          currentAssistant.todos = [...(currentAssistant.todos ?? []), ...todos]
        }
        if (attachments.length > 0) {
          currentAssistant.attachments = [...(currentAssistant.attachments ?? []), ...attachments]
        }
      }
    }
  }

  return transcript.filter((message) =>
    message.text.trim() !== '' ||
    (message.tools?.length ?? 0) > 0 ||
    (message.todos?.length ?? 0) > 0 ||
    (message.attachments?.length ?? 0) > 0 ||
    Boolean(message.reasoning),
  )
}
