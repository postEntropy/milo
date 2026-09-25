import type { Session } from '../core/session.js'
import { DEFAULT_DISPLAY, type DisplayConfig } from '../core/config/schema.js'
import { errorMessage } from '../util/errors.js'
import type { ChatSurface } from './surface.js'
import { toolLabel, toolLine } from './tool-line.js'

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
 * Runs a turn, and then whatever arrived too late to be read inside it: a
 * correction the model never saw becomes the next turn rather than being dropped.
 *
 * After a stop there is nothing left to take up — the stop was the answer to
 * everything sent by then — so the leftovers go with it. A stop is not a failure
 * either, and is not returned; a turn that died of anything else is, for the
 * surface to report in its own words and in its own place.
 */
export async function runTurns(options: RunTurnOptions): Promise<string | null> {
  const { steering, signal, ...turn } = options
  let pending = turn.text
  try {
    do {
      await runTurn({ ...turn, text: pending, steering, signal })
      pending = signal?.aborted ? '' : (steering?.splice(0).join('\n\n') ?? '')
    } while (pending)
  } catch (error) {
    return signal?.aborted ? null : errorMessage(error)
  }
  return null
}

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
  // The transport's own working indicator, kept on for as long as the turn runs.
  // The wait before the first token is the longest part of a turn and a bare '…'
  // does not say whether anything is happening. Stopped in the `finally` below,
  // the failing turn included.
  const stopTyping = surface.typing(conversationId)
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
  /** The kind of quote left open, so a run of tool lines can join it. */
  let openQuote: 'tool' | 'quote' | null = null
  let reasoning = ''

  const flush = async (force = false): Promise<void> => {
    const now = Date.now()
    if (!force && now - lastFlush < flushMs) return
    lastFlush = now
    await surface.edit(conversationId, messageId, clamp(output, maxLength))
  }

  /**
   * What a line is, and whether it joins the run of tool activity.
   *
   * `tool` lines are one burst of work, so consecutive ones share the same quote
   * — the model reading its own activity wants them together. A plain newline
   * inside a quote is a *soft break* and the engine reflows the lines into one
   * sentence ("… preços web_search OpenAI new model release …"), so the lines
   * inside a shared quote are separated by a hard break instead. `quote` is a
   * quoted line that is not part of that burst — a thought is the model talking,
   * and folding it into the arguments of the call that followed it is how the two
   * get read as one line.
   */
  type LineStyle = 'prose' | 'tool' | 'quote'

  const appendLine = async (line: string, style: LineStyle = 'prose'): Promise<void> => {
    if (style === 'prose') {
      output += output === '' ? line : `\n\n${line}`
    } else if (style === 'tool' && openQuote === 'tool') {
      output += `  \n> ${line}`
    } else {
      output += output === '' ? `> ${line}` : `\n\n> ${line}`
    }
    openQuote = style === 'prose' ? null : style
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
            output += '\n\n'
            atLineEnd = false
          }
          // The answer's own words end the run of tool activity: what follows is
          // prose, and the next tool line starts a quote of its own.
          openQuote = null
          output += event.delta
          await flush()
          break
        case 'tool-start': {
          await flushReasoning()
          if (display.tools === 'off') break
          // `name` shows which tool it is without the arguments beside it.
          await appendLine(
            display.tools === 'name'
              ? toolLine(event.name, undefined, { markdown: true })
              : toolLine(event.name, event.args, { markdown: true }),
            'tool',
          )
          break
        }
        case 'tool-end':
          // A failure is always reported: hiding it is worse than the noise.
          if (event.isError) {
            await appendLine(`❌ ${toolLabel(event.name, true)} failed`, 'tool')
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
  } finally {
    stopTyping()
  }

  await flushReasoning()
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
