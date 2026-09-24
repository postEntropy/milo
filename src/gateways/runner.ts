import type { Session } from '../core/session.js'
import { DEFAULT_DISPLAY, type DisplayConfig } from '../core/config/schema.js'
import { errorMessage } from '../util/errors.js'
import type { ChatSurface } from './surface.js'
import { toolLabel, toolLine, toolStyle, type ToolLineStyle } from './tool-line.js'

export interface RunTurnOptions {
  session: Session
  conversationId: string
  text: string
  surface: ChatSurface
  maxLength: number
  /** How much of the turn to show. Defaults to showing everything. */
  display?: DisplayConfig
  flushMs?: number
  signal?: AbortSignal
  /**
   * Where a message sent while this turn is running is handed in. Taken up at
   * the next step boundary; whatever is left when the turn ends was never seen,
   * and the caller runs it as its own turn.
   */
  steering?: string[]
}

const DEFAULT_FLUSH_MS = 900

/** Enough of a thought to say what it is about, not the whole thing. */
const REASONING_LIMIT = 200

/**
 * Runs one turn against a chat surface: posts a placeholder, streams the answer
 * by editing it (throttled), surfaces tool activity on its own lines, and routes
 * permission requests to the surface's inline prompt.
 */
export async function runTurn(options: RunTurnOptions): Promise<void> {
  const { session, conversationId, text, surface, maxLength } = options
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
  const display = options.display ?? DEFAULT_DISPLAY

  const messageId = await surface.post(conversationId, '…')
  let output = ''
  let lastFlush = 0
  // Whether anything arrived in the answer channel, and how much came through
  // the thinking one: a provider may fill only the second, and then the display
  // decides whether the turn shows anything at all.
  let answered = false
  let reasoningChars = 0
  // Tool/error lines end the current line, so the next text starts on its own.
  // A blank line is what separates blocks in Markdown, where a single newline is
  // a soft break and gets collapsed into the same paragraph.
  let atLineEnd = false
  let openBlock: ToolLineStyle | null = null
  let reasoning = ''

  /**
   * What has been written, with any open code fence closed.
   *
   * Each edit is parsed as a message of its own, so one that ends inside an open
   * fence is malformed Markdown — and a client that refuses it drops the whole
   * message to plain text, after which even the finished answer shows its `**`
   * and `>` as literals. A shell command streams well before its closing fence
   * exists, which is exactly when that happens. Only what is *sent* is closed:
   * the accumulator stays open, so the next line continues the same block.
   */
  const balanced = (): string => (openBlock === 'code' ? `${output}\n\`\`\`` : output)

  const flush = async (force = false): Promise<void> => {
    const now = Date.now()
    if (!force && now - lastFlush < flushMs) return
    lastFlush = now
    await surface.edit(conversationId, messageId, clamp(balanced(), maxLength))
  }

  /** Closes a code fence, so the prose after it is never swallowed by the block. */
  const closeBlock = (): void => {
    if (openBlock === 'code') output += '\n```'
    openBlock = null
  }

  /**
   * One line of prose, or one line of its own inside a tool block.
   *
   * Only the line that *opens* a quote block carries `>`; repeating it on the
   * lines inside makes Telegram show the marker as literal text. A block is also
   * a single paragraph, and a newline inside a paragraph is a soft break: two
   * tool lines in one quote reflow into a single sentence, which is how a search
   * followed by a search read as "… preços web_search OpenAI new model release
   * …". Every quote line therefore opens its own block. A code fence is not
   * affected — it keeps both the breaks and the literals — so consecutive shell
   * commands still share one.
   */
  const appendLine = async (
    line: string,
    style: 'prose' | ToolLineStyle = 'prose',
  ): Promise<void> => {
    if (style === 'prose') {
      closeBlock()
      output += output === '' ? line : `\n\n${line}`
    } else if (style === 'code' && openBlock === 'code') {
      output += `\n${line}`
    } else {
      const wasEmpty = output === ''
      closeBlock()
      output += wasEmpty ? '' : '\n\n'
      output += style === 'code' ? '```\n' : '> '
      output += line
      openBlock = style
    }

    atLineEnd = true
    await flush(true)
  }

  /**
   * Emits the reasoning gathered so far as one line, then forgets it. Called
   * when the thought is over — before prose or a tool line — and once at the end,
   * so a thought that leads nowhere is still visible.
   */
  const flushReasoning = async (): Promise<void> => {
    const line = firstLine(reasoning)
    reasoning = ''
    // One message, so one line is all the thought can have without crowding out
    // the answer.
    if (display.thinking === 'off' || !line) return
    await appendLine(`💭 ${line}`, 'quote')
  }

  try {
    for await (const event of session.send(text, {
      signal: options.signal,
      steering: options.steering,
      ask: async (request) => ({
        allowed: await surface.ask(conversationId, messageId, request),
      }),
    })) {
      switch (event.type) {
        case 'reasoning-delta':
          reasoningChars += event.delta.length
          if (display.thinking !== 'off') reasoning += event.delta
          break
        case 'text-delta':
          // Only text someone can read counts as an answer: a bare newline is not
          // one, and counting it would switch off the note below.
          if (event.delta.trim()) answered = true
          await flushReasoning()
          if (atLineEnd) {
            closeBlock()
            output += '\n\n'
            atLineEnd = false
          }
          output += event.delta
          await flush()
          break
        case 'tool-start': {
          await flushReasoning()
          if (display.tools === 'off') break
          // `name` shows which tool it is without the arguments beside it.
          const line =
            display.tools === 'name'
              ? toolLine(event.name, undefined, { markdown: true })
              : toolLine(event.name, event.args, { markdown: true })
          await appendLine(line.text, line.style)
          break
        }
        case 'tool-end':
          // A failure is always reported: hiding it is worse than the noise.
          if (event.isError) {
            const style = toolStyle(event.name)
            await appendLine(`❌ ${toolLabel(event.name, style, true)} failed`, style)
          }
          break
        case 'waiting':
          await appendLine('⏳ another Milo is using this session — waiting for it to finish', 'prose')
          break
        // Turns taken elsewhere are in the model's context but not on this
        // screen — and turns summarized there are in neither. Saying which is
        // what keeps the answer from reading as if it knew what nobody here saw.
        case 'rebased':
          await appendLine(`↺ another Milo has used this session: ${rebased(event)}`, 'prose')
          break
        case 'done':
          // A capped answer otherwise looks like a complete one.
          if (event.finishReason === 'length') {
            await appendLine('⚠ hit the output limit — the answer was cut off', 'prose')
          }
          break
        case 'aborted':
          await appendLine('🛑 stopped', 'prose')
          break
        case 'error':
          await appendLine(`[error] ${event.message}`)
          break
        default:
          break
      }
    }
  } catch (error) {
    await appendLine(`[error] ${errorMessage(error)}`)
  }

  await flushReasoning()
  closeBlock()
  // Nothing came back in the answer channel while the thinking channel had
  // content, and the display hid it: a chat that says nothing reads as the bot
  // being broken, when it is the provider putting both channels in one field.
  // The CLI says the same thing, for the same reason.
  if (!answered && reasoningChars > 0 && display.thinking === 'off') {
    output += `${output === '' ? '' : '\n\n'}⚠ no answer came back: this model sends everything it says as reasoning, and /thinking off hides it.`
  }
  await surface.edit(conversationId, messageId, clamp(output.trim() || '(no response)', maxLength))
}

/** What another Milo left in this session, as one clause. */
function rebased(event: { added: number; compacted: boolean }): string {
  const says: string[] = []
  if (event.added > 0) says.push(`${event.added} new message${event.added === 1 ? '' : 's'}`)
  if (event.compacted) says.push('the earlier turns are summarized')
  return says.join(' and ')
}

/** The first non-empty line of a thought, flattened. */
function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const flat = line.replace(/\s+/g, ' ').trim()
    if (flat) {
      return flat.length > REASONING_LIMIT ? `${flat.slice(0, REASONING_LIMIT - 1)}…` : flat
    }
  }
  return ''
}

/**
 * Trims a turn that outgrew the surface's message limit.
 *
 * Keeps the head *and* the tail. The answer comes after the tool log, so
 * trimming only the end is precisely how a limit eats the conclusion and leaves
 * the running commentary — the part nobody needed.
 */
function clamp(text: string, maxLength: number): string {
  if (!text) return '…'
  if (text.length <= maxLength) return text

  const marker = '… (trimmed to fit) …'
  const room = maxLength - marker.length
  if (room <= 20) return `${text.slice(0, maxLength - 1)}…`

  const head = Math.floor(room * 0.4)
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`
}
