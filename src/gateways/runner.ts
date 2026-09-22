import type { Session } from '../core/session.js'
import { errorMessage } from '../util/errors.js'
import type { ChatSurface } from './surface.js'
import { toolLine, toolStyle, type ToolLineStyle } from './tool-line.js'

export interface RunTurnOptions {
  session: Session
  conversationId: string
  text: string
  surface: ChatSurface
  maxLength: number
  flushMs?: number
  signal?: AbortSignal
}

const DEFAULT_FLUSH_MS = 900

/**
 * Runs one turn against a chat surface: posts a placeholder, streams the answer
 * by editing it (throttled), surfaces tool activity on its own lines, and routes
 * permission requests to the surface's inline prompt.
 */
export async function runTurn(options: RunTurnOptions): Promise<void> {
  const { session, conversationId, text, surface, maxLength } = options
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS

  const messageId = await surface.post(conversationId, '…')
  let output = ''
  let lastFlush = 0
  // Tool/error lines end the current line, so the next text starts on its own.
  // A blank line is what separates blocks in Markdown, where a single newline is
  // a soft break and gets collapsed into the same paragraph.
  let atLineEnd = false
  let openBlock: ToolLineStyle | null = null

  const flush = async (force = false): Promise<void> => {
    const now = Date.now()
    if (!force && now - lastFlush < flushMs) return
    lastFlush = now
    await surface.edit(conversationId, messageId, clamp(output, maxLength))
  }

  /** Closes a code fence, so the prose after it is never swallowed by the block. */
  const closeBlock = (): void => {
    if (openBlock === 'code') output += '\n```'
    openBlock = null
  }

  /**
   * One line of prose, or one line inside a tool block.
   *
   * Only the line that *opens* a quote block carries `>`; repeating it on the
   * lines inside makes Telegram show the marker as literal text.
   */
  const appendLine = async (
    line: string,
    style: 'prose' | ToolLineStyle = 'prose',
  ): Promise<void> => {
    if (style === 'prose') {
      closeBlock()
      output += output === '' ? line : `\n\n${line}`
    } else if (openBlock === style) {
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

  try {
    for await (const event of session.send(text, {
      signal: options.signal,
      ask: async (request) => ({
        allowed: await surface.ask(conversationId, messageId, request),
      }),
    })) {
      switch (event.type) {
        case 'text-delta':
          if (atLineEnd) {
            closeBlock()
            output += '\n\n'
            atLineEnd = false
          }
          output += event.delta
          await flush()
          break
        case 'tool-start': {
          const line = toolLine(event.name, event.args)
          await appendLine(line.text, line.style)
          break
        }
        case 'tool-end':
          if (event.isError) await appendLine(`✗ ${event.name} failed`, toolStyle(event.name))
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

  closeBlock()
  await surface.edit(conversationId, messageId, clamp(output.trim() || '(no response)', maxLength))
}

function clamp(text: string, maxLength: number): string {
  if (!text) return '…'
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}
