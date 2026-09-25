import WebSocket from 'ws'
import { errorMessage } from '../../util/errors.js'

/**
 * The DevTools protocol over one WebSocket.
 *
 * Chrome speaks JSON-RPC 2.0 with `id` on every command and `sessionId` on
 * everything aimed at a target (a page, an iframe). With `flatten: true` those
 * sessions ride the same socket, so a page and every frame inside it is one
 * connection rather than one connection each — which is the whole point: a
 * browser tool that opened a socket per call would pay a handshake on every
 * click, and the handshake is the part this exists to avoid.
 */

/** An error the browser itself reported, kept apart from transport failures. */
export class CdpError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'CdpError'
    this.code = code
  }
}

export interface SendOptions {
  /** Omitted for browser-scoped commands (`Target.*`, `Browser.*`). */
  sessionId?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** `-32001` is what Chrome answers a command for a session that has gone. */
const DETACHED = -32001

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
  sessionId?: string
}

interface Envelope {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

export type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void

export class CdpConnection {
  private readonly socket: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly handlers = new Map<string, Set<CdpEventHandler>>()
  private closed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data: WebSocket.RawData) => this.receive(data.toString()))
    socket.on('close', () => this.fail(new Error('the browser closed the connection')))
    socket.on('error', (error: Error) => this.fail(error))
  }

  /** Opens the socket and resolves once the browser is actually listening. */
  static connect(url: string, timeoutMs = 5_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
      const timer = setTimeout(() => {
        socket.terminate()
        reject(new Error(`timed out connecting to the browser at ${url}`))
      }, timeoutMs)

      const settle = (run: () => void) => {
        clearTimeout(timer)
        run()
      }
      socket.once('open', () => settle(() => resolve(new CdpConnection(socket))))
      socket.once('error', (error: Error) =>
        settle(() => reject(new Error(`could not reach the browser: ${errorMessage(error)}`))),
      )
    })
  }

  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, options: SendOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the browser connection is closed'))
    if (options.signal?.aborted) return Promise.reject(new Error('cancelled'))

    const id = this.nextId++
    const timer = setTimeout(() => {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      entry.cleanup()
      entry.reject(new Error(`${method} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`))
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const onAbort = () => {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      entry.cleanup()
      entry.reject(new Error('cancelled'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        cleanup,
        sessionId: options.sessionId,
      })
      this.socket.send(
        JSON.stringify({ id, method, ...(params ? { params } : {}), ...(options.sessionId ? { sessionId: options.sessionId } : {}) }),
        (error) => {
          if (!error) return
          const entry = this.pending.get(id)
          if (!entry) return
          this.pending.delete(id)
          clearTimeout(timer)
          cleanup()
          reject(new Error(`could not send ${method}: ${errorMessage(error)}`))
        },
      )
    })
  }

  /** Subscribes to a protocol event. Handlers are fire-and-forget, never awaited. */
  on(method: string, handler: CdpEventHandler): () => void {
    const set = this.handlers.get(method) ?? new Set<CdpEventHandler>()
    set.add(handler)
    this.handlers.set(method, set)
    return () => set.delete(handler)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.fail(new Error('the browser connection was closed'))
    this.socket.close()
  }

  get isClosed(): boolean {
    return this.closed
  }

  private receive(raw: string): void {
    let message: Envelope
    try {
      message = JSON.parse(raw) as Envelope
    } catch {
      return
    }

    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      entry.cleanup()
      if (message.error) {
        entry.reject(new CdpError(message.error.code, message.error.message))
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }

    if (!message.method) return
    // A session going away has to fail the commands aimed at it, or a click on
    // a page that navigated under it would hang until its timeout.
    if (message.method === 'Target.detachedFromTarget') {
      const gone = message.params?.sessionId
      if (typeof gone === 'string') this.failSession(gone)
    }

    const set = this.handlers.get(message.method)
    if (!set) return
    for (const handler of set) {
      try {
        handler(message.params ?? {}, message.sessionId)
      } catch {
        // An event handler must not take the socket down with it.
      }
    }
  }

  /** Rejects everything aimed at a target that has gone, and nothing else. */
  private failSession(sessionId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.cleanup()
      entry.reject(new CdpError(DETACHED, 'the page went away'))
    }
  }

  private fail(error: Error): void {
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.cleanup()
      entry.reject(error)
    }
    this.pending.clear()
  }
}

/** Long enough for a navigation, short enough that a stuck browser is named. */
export const DEFAULT_TIMEOUT_MS = 10_000
