import { apiToken } from './api.js'
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from '@protocol'
import { closeOutcome, type ConnectionStatus } from './connection.js'

export type { ConnectionState, ConnectionStatus } from './connection.js'

export class MiloSocket {
  private socket: WebSocket | null = null
  private chatId = ''
  /**
   * Whether this client draws a generated interface; declared on the handshake.
   * `null` says nothing at all, which is what a plain chat does — and what leaves
   * a capability the server already holds exactly as it was.
   */
  private genui: boolean | null = null
  private listeners = new Set<(frame: ServerFrame) => void>()
  private statusListeners = new Set<(status: ConnectionStatus) => void>()
  private retry = 0
  private closed = false
  private timer: number | undefined
  /** Whether the handshake finished for the socket open now; reset on each attempt. */
  private ready = false
  /** What the server said when it refused, before the handshake finished. */
  private refusal = ''
  private pending = new Map<string, { resolve(steered: boolean): void; reject(error: Error): void; timer: number }>()

  connect(chatId: string, genui: boolean | null = null): void {
    this.chatId = chatId
    this.genui = genui
    this.closed = false
    this.retire()
    this.open()
  }

  close(): void {
    this.closed = true
    this.retire()
  }

  reconnect(): void {
    if (this.closed || !this.chatId) return
    this.retry = 0
    this.retire()
    this.open()
  }

  /**
   * Detach the current socket before closing it, so the close event it fires
   * later finds `this.socket` pointing elsewhere and cannot revive a second
   * connection. Without this, a reconnect racing an earlier close leaves two
   * live sockets, and every frame arrives twice.
   */
  private retire(): void {
    window.clearTimeout(this.timer)
    this.failPending()
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  send(frame: ClientFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Milo disconnected.')
    this.socket.send(JSON.stringify(frame))
  }

  sendFor(chatId: string, frame: ClientFrame): void {
    if (this.chatId !== chatId) throw new Error('The active chat changed while files were uploading. Send them again.')
    this.send(frame)
  }

  /** Wait for the daemon to accept the message; never resend an uncertain delivery. */
  sendConfirmed(chatId: string, frame: Extract<ClientFrame, { type: 'send' | 'command' }>, requestId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Milo did not confirm the message. It may have arrived; check the session before sending again.'))
      }, 15000)
      this.pending.set(requestId, { resolve, reject, timer })
      try { this.sendFor(chatId, { ...frame, requestId }) } catch (error) {
        window.clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  private failPending(): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error('Connection lost before Milo confirmed the message. It may have arrived; check the session before sending again.'))
    }
    this.pending.clear()
  }

  subscribe(listener: (frame: ServerFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Told the state of the connection, and the reason when the server refused it. */
  subscribeStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private status(status: ConnectionStatus): void {
    for (const listener of this.statusListeners) listener(status)
  }

  private open(): void {
    const chatId = this.chatId
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL(`${scheme}//${location.host}/ws`)
    url.searchParams.set('t', apiToken())
    this.ready = false
    this.refusal = ''
    this.status({ state: 'connecting' })
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.retry = 0
      socket.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION, chatId, ...(this.genui ? { genui: this.genui } : {}) }))
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      try {
        const frame = JSON.parse(String(event.data)) as ServerFrame
        if (frame.type === 'send-result') {
          const pending = this.pending.get(frame.requestId)
          if (pending) {
            window.clearTimeout(pending.timer)
            this.pending.delete(frame.requestId)
            if (frame.ok) pending.resolve(frame.steered === true)
            else pending.reject(new Error(frame.error))
          }
          return
        }
        if (frame.type === 'ready') this.ready = true
        // The server names its refusal before it hangs up, and that text is a
        // better reason than the page could infer on its own.
        else if (frame.type === 'error' && !this.ready) this.refusal = frame.message
        for (const listener of this.listeners) listener(frame)
      } catch {
        for (const listener of this.listeners) listener({ type: 'error', message: 'Milo sent an invalid frame.' })
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.closed) return
      this.failPending()
      void this.afterClose(socket)
    })
    socket.addEventListener('error', () => socket.close())
  }

  /**
   * A close is not one thing. Having been online, it is a drop: the page has a
   * conversation to keep, and it retries. Having never finished the handshake,
   * the server either refused this page or was not there to answer it — and only
   * a plain request tells the two apart, since a browser cannot read the status
   * of a refused WebSocket upgrade. The refusal is terminal; retrying it is what
   * left the chip spinning with nothing said.
   */
  private async afterClose(socket: WebSocket): Promise<void> {
    const reachable = !this.ready && !this.refusal ? await this.isReachable() : false
    if (this.socket !== socket || this.closed) return
    const { retry, status } = closeOutcome({ everOnline: this.ready, error: this.refusal || undefined, reachable })
    this.status(status)
    if (!retry) return
    const delay = Math.min(500 * (2 ** this.retry), 8000)
    this.retry += 1
    this.timer = window.setTimeout(() => this.open(), delay)
  }

  /** Whether the server answers at all, so a refusal reads differently from a daemon that is down. */
  private async isReachable(): Promise<boolean> {
    try {
      await fetch(`${location.origin}/`, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(4000) })
      return true
    } catch {
      return false
    }
  }
}
