import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { AgentRuntime } from '../../core/runtime.js'
import type { Session } from '../../core/session.js'
import type { MemoryScope } from '../../core/memory/index.js'
import { isImage, type OutgoingFile, type OutgoingMessage } from '../../core/outgoing.js'
import { setDisplay, setPermissionMode, setReasoningEffort } from '../../core/config/load.js'
import { readDisplay } from '../../core/config/load.js'
import { handleCommand, handleTurnControl, turnOf, type CommandContext } from '../commands.js'
import { PendingDecisions } from '../pending.js'
import { TurnQueue } from '../turns.js'
import type { ClientFrame, FrameAttachment, SendTarget, ServerFrame, TranscriptMessage } from './protocol.js'
import { PERMISSION_TIMEOUT_MS } from './protocol.js'
import { displayEvent } from './turn.js'
import { showsToolCall, toolLine } from '../tool-line.js'

export interface WebClient {
  send(frame: ServerFrame): void
}

interface Conversation {
  scope: MemoryScope
  session: Session
  clients: Set<WebClient>
  activeTurnId?: string
}

export class WebHub {
  private readonly conversations = new Map<string, Conversation>()
  private readonly turns = new TurnQueue()
  private readonly pending = new PendingDecisions()
  /**
   * The files delivered into this process's conversations, by id. Only what is
   * here is ever served, so the browser cannot ask for a path of its own naming.
   * Rebuilt from a transcript as conversations are opened, which is why the id is
   * a hash of the path rather than a fresh token each time.
   */
  private readonly attachments = new Map<string, { path: string; name: string; mimeType: string }>()

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly identity: { provider: string; model: string },
  ) {}

  async connect(client: WebClient, conversationId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new Error('Invalid conversation id.')
    let conversation = this.conversations.get(conversationId)
    if (!conversation) {
      const scope: MemoryScope = { gateway: 'web', conversationId }
      conversation = { scope, session: await this.runtime.sessionFor(scope), clients: new Set() }
      this.conversations.set(conversationId, conversation)
    } else if (!this.turns.busy(conversationId)) {
      conversation.session = await this.runtime.getSession(conversation.scope)
    }
    conversation.clients.add(client)
    client.send({
      type: 'ready',
      version: 1,
      sessionId: conversation.session.id,
      messages: this.transcript(conversation.session),
      thinking: readDisplay().thinking,
      provider: this.identity.provider,
      model: this.runtime.model,
    })
    this.sendState(conversationId)
  }

  disconnect(client: WebClient): void {
    for (const conversation of this.conversations.values()) {
      conversation.clients.delete(client)
      if (conversation.clients.size === 0) this.turns.stop(conversation.scope.conversationId)
    }
  }

  handle(client: WebClient, frame: ClientFrame, conversationId: string): void {
    const conversation = this.conversations.get(conversationId)
    if (!conversation?.clients.has(client)) return

    if (frame.type === 'control') {
      if (frame.action === 'stop') {
        const result = this.turns.stop(conversationId)
        this.sendState(conversationId)
        if (!result.stopped) client.send({ type: 'error', message: 'Nothing is running to stop.' })
      } else if (frame.id) {
        const allowed = frame.action === 'allow'
        this.pending.resolve(frame.id, allowed)
        client.send({ type: 'permission-result', id: frame.id, allowed })
      }
      return
    }

    if (frame.type === 'send') {
      if (!frame.text.trim()) return
      if (frame.intent === 'steer') {
        const steered = this.turns.steer(conversationId, frame.text)
        if (steered) {
          const turnId = this.conversations.get(conversationId)?.activeTurnId
          if (turnId) this.broadcast(conversationId, { type: 'event', turnId, event: { type: 'steer', text: frame.text } })
          return
        }
      }
      this.startTurn(conversationId, frame.text, frame.target)
      return
    }

    if (frame.type === 'command') void this.command(client, conversation, frame.text).catch((error: unknown) => {
      client.send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  close(): void {
    for (const id of this.conversations.keys()) this.turns.stop(id)
  }

  /**
   * Posts a message into a conversation with no turn behind it — how a routine
   * reaches a web chat, and how a live turn's own files reach it too: the answer
   * is already on screen, so the files arrive as their own message. It is written
   * into the conversation's session first, so it is there when the tab is next
   * opened, and then broadcast to whoever is watching right now; the broadcast is
   * a no-op when nobody is. The frame is the one a command reply uses, so the
   * chat renders it and lists it like any other message without the protocol
   * knowing about routines.
   */
  async deliver(conversationId: string, message: OutgoingMessage): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) {
      throw new Error(`not a web conversation id: ${conversationId}`)
    }
    const files = message.files ?? []
    const text = message.text ?? ''
    const session = await this.runtime.getSession({ gateway: 'web', conversationId })
    await session.appendNotice(text, files)
    const attachments = files.map((file) => this.register(file))
    this.broadcast(conversationId, {
      type: 'command-result',
      reply: text,
      markdown: text,
      ...(attachments.length > 0 ? { attachments } : {}),
    })
  }

  /** The file behind an id, for the HTTP layer to stream. Null when none was delivered under it. */
  attachment(id: string): { path: string; name: string; mimeType: string } | null {
    return this.attachments.get(id) ?? null
  }

  /**
   * Notes a delivered file under its id and describes it for the browser. The id
   * is the path's hash, so opening the same conversation again — a reload, a tab
   * reopened later — registers the same id the page was already given.
   */
  private register(file: OutgoingFile): FrameAttachment {
    const id = createHash('sha1').update(file.path).digest('hex')
    const size = statSync(file.path, { throwIfNoEntry: false })?.size ?? 0
    this.attachments.set(id, { path: file.path, name: file.name, mimeType: file.mimeType })
    return { id, name: file.name, mimeType: file.mimeType, size, image: isImage(file.mimeType) }
  }

  private startTurn(conversationId: string, text: string, target?: SendTarget): void {
    // The state frame that *ends* a turn comes from the queue's settle handler
    // below, not from the turn's own `finally`. `busy` is the queue's answer to
    // "is a turn running", and the queue only lets the turn go after this work
    // returns — so a state read inside the body reports the turn still running.
    // Being the last one sent, that left the page's stop button where it was, and
    // pressing it answered "nothing is running to stop". The frame under it is the
    // other half: sent at once, so a message enqueued behind a running turn shows
    // up as queued now rather than when that turn ends.
    this.turns.run(conversationId, async (inbox, signal) => {
      const id = randomUUID()
      const activeConversation = this.conversations.get(conversationId)
      if (activeConversation) activeConversation.activeTurnId = id
      this.broadcast(conversationId, { type: 'turn-start', id, text })
      let status: 'done' | 'stopped' | 'error' = 'done'
      const display = readDisplay()
      try {
        let currentText = text
        while (currentText && !signal.aborted) {
          const conversation = this.conversations.get(conversationId)
          if (!conversation) return
          let session = await this.runtime.getSession(conversation.scope)
          conversation.session = session
          const command = await handleCommand(currentText, this.commandContext(conversation, session, signal))
          if (command.handled) {
            session = await this.runtime.getSession(conversation.scope)
            conversation.session = session
            this.broadcast(conversationId, { type: 'command-result', reply: command.reply ?? '', markdown: command.markdown, sessionId: session.id })
            const queuedText = inbox.shift()
            if (queuedText?.startsWith('/')) {
              const queuedCommand = await handleCommand(queuedText, this.commandContext(conversation, session, signal))
              conversation.session = await this.runtime.getSession(conversation.scope)
              if (queuedCommand.handled) this.broadcast(conversationId, { type: 'command-result', reply: queuedCommand.reply ?? '', markdown: queuedCommand.markdown, sessionId: conversation.session.id })
              currentText = inbox.shift() ?? ''
            } else {
              currentText = queuedText ?? ''
            }
            continue
          }

          for await (const event of session.send(currentText, {
            signal,
            steering: inbox,
            // A screen may pin where this turn is addressing — the routines screen
            // names a routine's destination, and the tool takes it from here
            // rather than from the chat the turn happens to be running in.
            ...(target ? { origin: target } : {}),
            ask: async (request) => {
              const permissionId = randomUUID()
              this.broadcast(conversationId, {
                type: 'permission',
                id: permissionId,
                request,
                expiresAt: Date.now() + PERMISSION_TIMEOUT_MS,
              })
              const allowed = await this.pending.wait(permissionId, PERMISSION_TIMEOUT_MS, signal)
              this.broadcast(conversationId, { type: 'permission-result', id: permissionId, allowed })
              return { allowed }
            },
          })) {
            if (event.type === 'error') status = 'error'
            if (event.type === 'aborted') status = 'stopped'
            displayEvent(event, id, display, (frame) => this.broadcast(conversationId, frame))
          }
          // The files this turn asked to send, read once it is over. They go
          // through the delivery a routine's answer uses, so the transcript keeps
          // them and a reload serves them again.
          const files = session.takeOutgoing()
          if (files.length > 0) {
            try {
              await this.deliver(conversationId, { files })
            } catch (error) {
              this.broadcast(conversationId, { type: 'error', message: error instanceof Error ? error.message : String(error) })
            }
          }
          currentText = inbox.shift() ?? ''
        }
      } catch (error) {
        status = signal.aborted ? 'stopped' : 'error'
        this.broadcast(conversationId, {
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        this.broadcast(conversationId, { type: 'turn-end', id, status })
        const endedConversation = this.conversations.get(conversationId)
        if (endedConversation?.activeTurnId === id) endedConversation.activeTurnId = undefined
      }
    }, () => this.sendState(conversationId))
    this.sendState(conversationId)
  }

  private async command(client: WebClient, conversation: Conversation, text: string): Promise<void> {
    const context = this.commandContext(conversation, conversation.session, new AbortController().signal)
    const result = handleTurnControl(text, {
      turn: turnOf(this.turns, conversation.scope.conversationId),
      start: (pending) => this.startTurn(conversation.scope.conversationId, pending),
    })
    if (result.handled) {
      client.send({ type: 'command-result', reply: result.reply ?? '' })
      this.sendState(conversation.scope.conversationId)
      return
    }
    this.turns.run(conversation.scope.conversationId, async () => {
      const response = await handleCommand(text, context)
      if (response.handled) {
        const refreshed = await this.runtime.getSession(conversation.scope)
        conversation.session = refreshed
        client.send({ type: 'command-result', reply: response.reply ?? '', markdown: response.markdown, sessionId: refreshed.id })
      }
      this.sendState(conversation.scope.conversationId)
    })
  }

  private commandContext(conversation: Conversation, session: Session, signal: AbortSignal): CommandContext {
    return {
      policy: this.runtime.permissions,
      resetSession: () => session.clear(),
      persistMode: (mode) => { this.runtime.permissions?.setMode(mode); setPermissionMode(mode) },
      display: readDisplay(),
      persistDisplay: setDisplay,
      effort: this.runtime.reasoningEffort,
      persistEffort: (effort) => { this.runtime.setReasoningEffort(effort); setReasoningEffort(effort) },
      newSession: (title) => this.runtime.newSession(conversation.scope, title),
      resumeSession: async (id) => (await this.runtime.resumeSession(conversation.scope, id)) !== null,
      listSessions: () => this.runtime.listSessions(),
      sessionStats: () => session.stats(),
      compactSession: () => session.compact(signal),
      skills: () => this.runtime.skills,
      memories: (limit) => session.memories(limit),
      forgetMemory: (id) => session.forget(id),
    }
  }

  private sendState(conversationId: string): void {
    this.broadcast(conversationId, {
      type: 'state',
      busy: this.turns.busy(conversationId),
      queued: this.turns.queued(conversationId),
    })
  }

  private broadcast(conversationId: string, frame: ServerFrame): void {
    for (const client of this.conversations.get(conversationId)?.clients ?? []) client.send(frame)
  }

  /**
   * A session's history as the page renders it. Reading it re-registers any file
   * it delivered, so a delivered picture is served again after a reload without
   * anything being kept in memory across restarts.
   */
  private transcript(session: Session): TranscriptMessage[] {
    return session.messages.flatMap((message): TranscriptMessage[] => {
      if (message.role !== 'user' && message.role !== 'assistant') return []
      const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
      const reasoning = message.content.filter((part) => part.type === 'reasoning').map((part) => part.text).join('')
      // The tool calls stay with the turn they belong to: a session read back — a
      // reload, or a tab opened later — shows the same lines the live stream drew,
      // from the same formatter the other surfaces use.
      const tools = message.content.flatMap((part) =>
        part.type === 'tool-call' && showsToolCall(part.name) ? [toolLine(part.name, part.args)] : [],
      )
      const attachments = message.content.flatMap((part) =>
        part.type === 'file'
          ? [this.register({ path: part.path, name: part.name, mimeType: part.mimeType })]
          : [],
      )
      if (!text && !reasoning && tools.length === 0 && attachments.length === 0) return []
      return [{
        role: message.role,
        text,
        ...(reasoning ? { reasoning } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }]
    })
  }
}
