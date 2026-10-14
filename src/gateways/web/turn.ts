import { toolDraw, toolResult } from '../tool-line.js'
import type { DisplayConfig } from '../../core/config/schema.js'
import type { AgentEvent, ServerFrame } from './protocol.js'

export type SendFrame = (frame: ServerFrame) => void

export function displayEvent(event: AgentEvent, turnId: string, display: DisplayConfig, send: SendFrame): void {
  if (event.type === 'tool-start') {
    // Whether the call is drawn at all is `toolDraw`'s answer — the same one a
    // session read back from disk and the settings preview use, so the three can
    // no longer disagree. What is left here is the wire's shape of that answer:
    // `name` withholds the args rather than pre-formatting a shorter string, so
    // the one formatter still decides the line's shape.
    const mark = toolDraw(event.name, event.args, display.tools)
    if (!mark) return
    // The line is sent as well as the arguments. The browser re-reads the args
    // through the same formatter it imports, but a surface that cannot import the
    // TypeScript — the phone — reads this instead of keeping a copy that would
    // drift, the way `ToolMark.text` already carries a stored call's line.
    send({
      type: 'event',
      turnId,
      event: { ...event, text: mark.text, args: display.tools === 'name' ? undefined : event.args },
    })
    return
  }
  if (event.type === 'tool-end') {
    // The result rides the same level as the line: at `full` the call shows what it came
    // back with, and below it the line is a name alone, so the result is not offered at
    // all. Empty rather than absent, because the event's own shape carries a string — the
    // surfaces read an empty result as "draw nothing".
    const result = display.tools === 'full' ? toolResult(event.result) : ''
    send({ type: 'event', turnId, event: { ...event, result } })
    return
  }
  if (event.type === 'reasoning-delta' && display.thinking === 'off') return
  send({ type: 'event', turnId, event })
}
