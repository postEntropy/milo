import { randomUUID } from 'node:crypto'
import type { AgentRuntime } from '../../core/runtime.js'
import type { Session } from '../../core/session.js'
import type { MemoryScope } from '../../core/memory/index.js'
import { setDisplay, setPermissionMode, setReasoningEffort } from '../../core/config/load.js'
import { readDisplay } from '../../core/config/load.js'
import { handleCommand, handleTurnControl, turnOf, type CommandContext } from '../commands.js'
import { PendingDecisions } from '../pending.js'
import { TurnQueue } from '../turns.js'
import type { ClientFrame, ServerFrame, TranscriptMessage } from './protocol.js'
import { PERMISSION_TIMEOUT_MS } from './protocol.js'
import { displayEvent } from './turn.js'
import { toolLine } from '../tool-line.js'

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
      messages: transcript(conversation.session),
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
      this.startTurn(conversationId, frame.text)
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
   * reaches a web chat. It is written into the conversation's session first, so
   * it is there when the tab is next opened, and then broadcast to whoever is
   * watching right now; the broadcast is a no-op when nobody is. The frame is the
   * one a command reply uses, so the chat renders it and lists it like any other
   * message without the protocol knowing about routines.
   */
  async deliver(conversationId: string, text: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) {
      throw new Error(`not a web conversation id: ${conversationId}`)
    }
    const session = await this.runtime.getSession({ gateway: 'web', conversationId })
    await session.appendNotice(text)
    this.broadcast(conversationId, { type: 'command-result', reply: text, markdown: text })
  }

  private startTurn(conversationId: string, text: string): void {
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
}

function transcript(session: Session): TranscriptMessage[] {
  return session.messages.flatMap((message): TranscriptMessage[] => {
    if (message.role !== 'user' && message.role !== 'assistant') return []
    const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    const reasoning = message.content.filter((part) => part.type === 'reasoning').map((part) => part.text).join('')
    // The tool calls stay with the turn they belong to: a session read back — a
    // reload, or a tab opened later — shows the same lines the live stream drew,
    // from the same formatter the other surfaces use.
    const tools = message.content.flatMap((part) => part.type === 'tool-call' ? [toolLine(part.name, part.args)] : [])
    if (!text && !reasoning && tools.length === 0) return []
    return [{
      role: message.role,
      text,
      ...(reasoning ? { reasoning } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    }]
  })
}
