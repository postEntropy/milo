import { toolIcon, toolLine } from '../tool-line.js'
import type { AgentEvent, ServerFrame } from './protocol.js'

type DisplayConfig = { tools: 'full' | 'name' | 'off'; thinking: 'on' | 'off' }

export type SendFrame = (frame: ServerFrame) => void

export function displayEvent(event: AgentEvent, turnId: string, display: DisplayConfig, send: SendFrame): void {
  if (event.type === 'tool-start') {
    if (display.tools === 'off') return
    send({
      type: 'event',
      turnId,
      event: {
        type: 'text-delta',
        delta: display.tools === 'name'
          ? `${toolIcon(event.name)} ${event.name}\n`
          : `${toolLine(event.name, event.args, { markdown: true })}\n`,
      },
    })
    return
  }
  if (event.type === 'tool-end' && event.isError) {
    send({ type: 'event', turnId, event: { type: 'text-delta', delta: `❌ ${event.name} failed\n` } })
    return
  }
  if (event.type === 'reasoning-delta' && display.thinking === 'off') return
  send({ type: 'event', turnId, event })
}
