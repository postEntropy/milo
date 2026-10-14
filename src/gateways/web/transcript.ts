import type { OutgoingFile } from '../../core/outgoing.js'
import { genUiFromArgs } from '../../core/genui.js'
import { GenUiFence } from '../../core/genui-fence.js'
import type { PanelRequest } from '../../core/panel.js'
import type { Message } from '../../core/providers/types.js'
import { todosFromArgs } from '../../core/todos.js'
import { rawTurn } from '../raw.js'
import { drawsToolFailure, toolDraw, toolResult, toolText, type ToolLevel } from '../tool-line.js'
import type { FrameAttachment, ToolState, TranscriptMessage, TranscriptPart } from './protocol.js'

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
 *
 * The turn's raw copy rides on the same group: the assistant and `tool` messages it was
 * drawn from are kept aside and rendered whole once the group closes, so a surface can
 * copy the arguments and the results the drawn parts leave out.
 *
 * `level` is the display setting's, applied here by the same function the live turn
 * applies it with — a session read back is not allowed to draw more of a call than
 * the turn that made it did.
 */
export function transcriptOf(messages: Message[], register: RegisterFile, level: ToolLevel = 'full'): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  let currentAssistant: TranscriptMessage | null = null
  /** The assistant and `tool` messages behind the group being built, for its raw. */
  let sources: Message[] = []

  // What became of each call. The result rides on a message of its own, after the
  // call, so every outcome is gathered before anything is drawn: a line that cannot
  // say it failed is a line that lies — and the result is kept with it for the detail
  // under the line.
  const outcomes = new Map<string, { failed: boolean; result: string }>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type === 'tool-result') outcomes.set(part.id, { failed: part.isError === true, result: part.content })
    }
  }

  /**
   * How a call ended, for the line beside it. Nothing to say where no result came. The
   * result is offered only at `full`: below it the line is the name alone, and a detail
   * under a name the person asked to keep short is the level not being honoured.
   */
  const endingOf = (id: string): { state?: ToolState; result?: string } => {
    const outcome = outcomes.get(id)
    if (!outcome) return {}
    const result = level === 'full' ? toolResult(outcome.result) : ''
    return { state: outcome.failed ? 'failed' : 'done', ...(result ? { result } : {}) }
  }

  /**
   * Seals the open group: its raw is rendered now that the last of its steps is in, and
   * the copy without the output beside it when that reads any differently — a group with
   * no result to leave out offers one copy, not two.
   */
  const closeAssistant = (): void => {
    if (currentAssistant) {
      const raw = rawTurn(sources)
      if (raw) {
        currentAssistant.raw = raw
        const noOutput = rawTurn(sources, { output: false })
        if (noOutput && noOutput !== raw) currentAssistant.rawNoOutput = noOutput
      }
    }
    currentAssistant = null
    sources = []
  }

  for (const message of messages) {
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    if (message.role === 'user') {
      closeAssistant()
      const attachments = message.content.flatMap((part) => part.type === 'image'
        ? [register({ path: part.path, name: part.name, mimeType: part.mimeType })]
        : [])
      if (text || attachments.length) {
        transcript.push({ role: 'user', parts: text ? [{ kind: 'text', text }] : [], ...(attachments.length ? { attachments } : {}), ...(message.at !== undefined ? { at: message.at } : {}) })
      }
      continue
    }
    if (message.role === 'assistant') {
      sources.push(message)
      const parts: TranscriptPart[] = []
      const attachments = message.content.flatMap((part) => part.type === 'file'
        ? [register({ path: part.path, name: part.name, mimeType: part.mimeType })]
        : [])
      // Walked in order, so a tool line lands between the prose around it. The
      // plan rides on the `todo` call's own arguments, so it survives a reload
      // the way any other part of the transcript does.
      for (const part of message.content) {
        if (part.type === 'reasoning' && part.text) parts.push({ kind: 'reasoning', text: part.text })
        else if (part.type === 'text' && part.text) parts.push(...textParts(part.text))
        else if (part.type === 'tool-call') {
          // A session stored while a turn could draw by calling a tool still holds
          // the call, so its widget is read back out of the arguments here. Nothing
          // writes one any more — this is how that history keeps drawing instead of
          // losing a widget it showed.
          if (part.name === 'render_ui') {
            const render = genUiFromArgs(part.args)
            if (render) parts.push({ kind: 'ui', render })
          }
          const todos = todosFromArgs(part.args)
          if (todos.length > 0) parts.push({ kind: 'todo', items: todos })
          const mark = toolDraw(part.name, part.args, level)
          if (mark) parts.push({ kind: 'tool', tool: { ...mark, ...endingOf(part.id) } })
          else if (drawsToolFailure(part.name) && outcomes.get(part.id)?.failed === true) {
            // The call draws nothing of its own — its result is what the person is
            // looking at — but a failure is still said. Nothing goes wrong in silence.
            parts.push({ kind: 'tool', tool: { name: part.name, text: toolText(part.name), state: 'failed' } })
          }
        }
      }

      if (!currentAssistant) {
        currentAssistant = {
          role: 'assistant',
          parts,
          ...(attachments.length > 0 ? { attachments } : {}),
          // The turn's start, not the last step: a turn drawn as one message is
          // said to have happened when it began.
          ...(message.at !== undefined ? { at: message.at } : {}),
        }
        transcript.push(currentAssistant)
      } else {
        if (parts.length > 0) currentAssistant.parts.push(...parts)
        if (attachments.length > 0) currentAssistant.attachments = [...(currentAssistant.attachments ?? []), ...attachments]
      }
      continue
    }
    // A tool result belongs to the group it answered: it draws nothing of its own — the
    // call beside the prose already names it — but it is half of the raw copy.
    if (message.role === 'tool') sources.push(message)
  }
  closeAssistant()

  return transcript.filter((message) => message.parts.length > 0 || (message.attachments?.length ?? 0) > 0)
}

/**
 * The stored text of a step, split the way it was split as it arrived.
 *
 * A turn that draws by writing keeps its block in the transcript verbatim — it is
 * the model's own words, and the model reads them back on the next request. So
 * reading a turn back is the same act as streaming it: the same splitter, handed
 * the whole text at once instead of a token at a time. Prose and widgets come out
 * in the order they were written, which is what a reload has to draw, and a block
 * that is no longer drawable comes back as its own text exactly as it did live.
 */
function textParts(text: string): TranscriptPart[] {
  const fence = new GenUiFence()
  const parts: TranscriptPart[] = []
  for (const part of [...fence.push(text), ...fence.finish()]) {
    // No drafts are asked of this fence, so a block here is one the model finished.
    if (part.kind === 'ui') parts.push({ kind: 'ui', render: part.render })
    else if (part.kind === 'text' || part.kind === 'refused') parts.push({ kind: 'text', text: part.text })
  }
  return parts
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
