import { toolDraw } from '../tool-line.js'
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
    if (!toolDraw(event.name, event.args, display.tools)) return
    send({ type: 'event', turnId, event: { ...event, args: display.tools === 'name' ? undefined : event.args } })
    return
  }
  if (event.type === 'reasoning-delta' && display.thinking === 'off') return
  send({ type: 'event', turnId, event })
}
