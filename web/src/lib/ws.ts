import { apiToken } from './api.js'
import type { ClientFrame, ServerFrame } from '@protocol'

/** `online` only once the server has answered the handshake; the rest are shown. */
export type ConnectionState = 'connecting' | 'online' | 'offline'

export class MiloSocket {
  private socket: WebSocket | null = null
  private conversationId = ''
  private listeners = new Set<(frame: ServerFrame) => void>()
  private statusListeners = new Set<(state: ConnectionState) => void>()
  private retry = 0
  private closed = false
  private timer: number | undefined

  connect(conversationId: string): void {
    this.conversationId = conversationId
    this.closed = false
    this.retire()
    this.open()
  }

  close(): void {
    this.closed = true
    this.retire()
  }

  /**
   * Detach the current socket before closing it, so the close event it fires
   * later finds `this.socket` pointing elsewhere and cannot revive a second
   * connection. Without this, a reconnect racing an earlier close leaves two
   * live sockets, and every frame arrives twice.
   */
  private retire(): void {
    window.clearTimeout(this.timer)
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  send(frame: ClientFrame): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Milo disconnected.')
    this.socket.send(JSON.stringify(frame))
  }

  sendFor(conversationId: string, frame: ClientFrame): void {
    if (this.conversationId !== conversationId) throw new Error('The active chat changed while files were uploading. Send them again.')
    this.send(frame)
  }

  subscribe(listener: (frame: ServerFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Told when the connection drops and while it is being re-established. */
  subscribeStatus(listener: (state: ConnectionState) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private status(state: ConnectionState): void {
    for (const listener of this.statusListeners) listener(state)
  }

  private open(): void {
    const conversationId = this.conversationId
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL(`${scheme}//${location.host}/ws`)
    url.searchParams.set('t', apiToken())
    this.status('connecting')
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.retry = 0
      socket.send(JSON.stringify({ type: 'hello', version: 1, conversationId }))
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      try {
        const frame = JSON.parse(String(event.data)) as ServerFrame
        for (const listener of this.listeners) listener(frame)
      } catch {
        for (const listener of this.listeners) listener({ type: 'error', message: 'Milo sent an invalid frame.' })
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.closed) return
      this.status('offline')
      const delay = Math.min(500 * (2 ** this.retry), 8000)
      this.retry += 1
      this.timer = window.setTimeout(() => this.open(), delay)
    })
    socket.addEventListener('error', () => socket.close())
  }
}
