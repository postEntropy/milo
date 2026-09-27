import type { AgentRuntime } from '../../core/runtime.js'
import { errorMessage } from '../../util/errors.js'
import { hyperlink } from '../../util/terminal.js'
import type { Gateway } from '../types.js'
import { startWebServer, webUiBuilt, type RunningWebServer } from './http.js'

export interface WebGatewayOptions {
  runtime: AgentRuntime
  cwd: string
  host: string
  port: number
  token?: string
  identity: { provider: string; model: string }
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
        identity: this.options.identity,
      })
    } catch (error) {
      // A port someone else holds must not take the daemon down with it: the bots
      // are a working install on their own, and the web UI is one surface among
      // them. Said out loud, because a silent skip reads as a feature that is on.
      console.error(`✗ the web UI did not start: ${errorMessage(error)}`)
      this.running = null
      return
    }
    if (!webUiBuilt()) {
      console.error('! the web UI is not built — run `npm run build:web`, then reload the page')
    }
    console.error(`Milo web · ${hyperlink(this.running.url)}`)
  }

  async stop(): Promise<void> {
    await this.running?.stop()
    this.running = null
  }

  async deliver(conversationId: string, text: string): Promise<void> {
    if (!this.running) throw new Error('the web UI is not running')
    await this.running.deliver(conversationId, text)
  }
}
