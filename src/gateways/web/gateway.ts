import type { AgentRuntime } from '../../core/runtime.js'
import type { OutgoingMessage } from '../../core/outgoing.js'
import { hyperlink } from '../../util/terminal.js'
import type { Gateway } from '../types.js'
import {
  bindProblem,
  startWebServer,
  webReachLines,
  webUiBuilt,
  type RunningWebServer,
} from './http.js'

export interface WebGatewayOptions {
  runtime: AgentRuntime
  cwd: string
  host: string
  port: number
  token?: string
}

/**
 * The web UI as a gateway, so `milo serve` starts it beside the bots instead of
 * it being a process nobody knows how to launch. `deliver` is the one thing it
 * can be written to out of band with — a routine's answer, which lands in the
 * conversation's session when nobody is watching and is broadcast when somebody
 * is.
 */
export class WebGateway implements Gateway {
  readonly id = 'web' as const
  private running: RunningWebServer | null = null

  constructor(private readonly options: WebGatewayOptions) {}

  async start(): Promise<void> {
    try {
      this.running = await startWebServer({
        runtime: this.options.runtime,
        cwd: this.options.cwd,
        host: this.options.host,
        port: this.options.port,
        token: this.options.token,
      })
    } catch (error) {
      // A port someone else holds must not take the daemon down with it: the bots
      // are a working install on their own, and the web UI is one surface among
      // them. Said out loud — with the address it tried, and in terms of what to
      // change — because a silent skip reads as a feature that is on.
      const { host, port } = this.options
      console.error(`✗ the web UI did not start at ${host}:${port}: ${bindProblem(error, host, port)}`)
      this.running = null
      return
    }
    if (!webUiBuilt()) {
      console.error('! the web UI is not built — run `npm run build:web`, then reload the page')
    }
    console.error(`Milo web · ${hyperlink(this.running.url)}`)
    for (const line of webReachLines(this.options.host, this.running.urls)) console.error(line)
  }

  async stop(): Promise<void> {
    await this.running?.stop()
    this.running = null
  }

  async deliver(conversationId: string, message: OutgoingMessage): Promise<void> {
    if (!this.running) throw new Error('the web UI is not running')
    await this.running.deliver(conversationId, message)
  }

  /** Shows a finished job's announcement, already written to the transcript. */
  showNotice(conversationId: string, message: OutgoingMessage): void {
    this.running?.showNotice(conversationId, message)
  }

  /** A routine ran: every page open on the web UI re-reads the history it shows. */
  routinesChanged(): void {
    this.running?.routinesChanged()
  }
}
