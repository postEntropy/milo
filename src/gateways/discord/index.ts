import type { ActionRowBuilder, ButtonBuilder, Client, Message } from 'discord.js'
import type { MemoryScope } from '../../core/memory/index.js'
import type { AgentRuntime } from '../../core/runtime.js'
import type { PermissionRequest } from '../../core/tools/permission.js'
import { errorMessage } from '../../util/errors.js'
import type { OutgoingFile, OutgoingMessage } from '../../core/outgoing.js'
import { readDisplay, setDisplay, setPermissionMode, setReasoningEffort } from '../../core/config/load.js'
import { denialMessage, isAllowed } from '../access.js'
import {
  displayLockMessage,
  effortLockMessage,
  handleCommand,
  handleTurnControl,
  memoryLockMessage,
  modeLockMessage,
  parseTurnControl,
  sessionLockMessage,
  turnOf,
} from '../commands.js'
import { runTurns } from '../runner.js'
import { chunk } from '../chunk.js'
import { TurnQueue } from '../turns.js'
import type { ChatSurface } from '../surface.js'
import type { Gateway } from '../types.js'
import {
  ActionRouter,
  buildSessionsList,
  toDiscordComponents,
  type ActionContext,
  type DiscordBuilders,
} from '../actions.js'

export interface DiscordGatewayOptions {
  runtime: AgentRuntime
  token: string
  /** Empty/undefined means anyone may talk to the bot. */
  allowlist?: string[]
}

const ASK_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Resolves when the turn is stopped — or never, when it is never stopped, which
 * is what makes it usable as the other side of a race. A prompt has no signal of
 * its own in discord.js, so this is how a stop reaches it.
 */
function untilStopped(signal: AbortSignal | undefined): Promise<null> {
  return new Promise<null>((resolve) => {
    if (signal?.aborted) {
      resolve(null)
      return
    }
    signal?.addEventListener('abort', () => resolve(null), { once: true })
  })
}

const MAX_LENGTH = 1900
/** Discord takes at most ten files in one message; the rest go in a following one. */
const FILES_PER_MESSAGE = 10

/**
 * Asks one channel for a permission decision. The signal is the turn's own: a
 * stopped turn takes its prompt down with it rather than leaving it standing.
 */
type ChannelAsk = (
  target: Message,
  request: PermissionRequest,
  signal?: AbortSignal,
) => Promise<boolean>

/**
 * Discord's typing indicator lasts about ten seconds, so it is refreshed just
 * inside that window for as long as a turn runs.
 */
const TYPING_REFRESH_MS = 8_000

export class DiscordGateway implements Gateway {
  readonly id = 'discord' as const
  private client: Client | undefined
  private builders: DiscordBuilders | undefined
  private readonly turns = new TurnQueue()

  constructor(private readonly options: DiscordGatewayOptions) {}

  async start(): Promise<void> {
    const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } =
      await import('discord.js')

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })

    this.builders = { ActionRowBuilder, ButtonBuilder, ButtonStyle }
    const builders = this.builders

    const actionRouter = new ActionRouter()
    actionRouter.on('sessions', async (payload, context) => {
      const outcome = buildSessionsList(await this.options.runtime.listSessions(), payload)
      if (!outcome.ok) {
        await context.edit({ text: outcome.error, markdown: outcome.error, actions: [] })
        return
      }
      await context.edit({
        text: outcome.result.markdown,
        markdown: outcome.result.markdown,
        actions: outcome.result.actions,
      })
    })

    const ask = async (
      target: Message,
      request: PermissionRequest,
      signal?: AbortSignal,
    ): Promise<boolean> => {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('perm:allow').setLabel('Allow').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('perm:deny').setLabel('Deny').setStyle(ButtonStyle.Danger),
      )

      const prompt = await target.reply({
        content: `⚠ Allow ${request.tool}?\n\n${request.summary}`,
        components: [row],
      })

      try {
        // Raced against the stop: `awaitMessageComponent` has no signal of its
        // own, and a prompt that outlives the turn it belongs to would keep the
        // turn parked — and honour a later ✅ on a tool the stop was meant to
        // prevent. Its own timeout and its own dismissal are both "no answer".
        const clicked = prompt
          .awaitMessageComponent({
            time: ASK_TIMEOUT_MS,
            filter: (candidate) => candidate.user.id === target.author.id,
          })
          .catch(() => null)
        const interaction = await Promise.race([clicked, untilStopped(signal)])

        if (!interaction) {
          // Fail closed, and take the buttons away with the decision: the prompt
          // is a question a stopped turn no longer has.
          await prompt
            .edit({ content: '🛑 Stopped before this was answered — denied.', components: [] })
            .catch(() => undefined)
          return false
        }

        const allowed = interaction.customId === 'perm:allow'
        await interaction.update({
          content: allowed ? '✅ Allowed' : '🚫 Denied',
          components: [],
        })
        return allowed
      } catch {
        // Timed out — fail closed.
        return false
      }
    }

    client.on(Events.MessageCreate, (message) => {
      if (message.author.bot) return
      const text = message.content.trim()
      if (!text) return

      if (
        !isAllowed(this.options.allowlist, [message.author.id, message.channelId, message.guildId])
      ) {
        void message.reply(denialMessage(message.author.id)).catch(() => undefined)
        return
      }

      // `/stop`, `/steer` and `/queue` are about the turn itself, so they are
      // answered here rather than inside one: a `/stop` that waited for the turn
      // it is meant to stop would arrive after it.
      if (parseTurnControl(text)) {
        const result = handleTurnControl(text, {
          turn: turnOf(this.turns, message.channelId),
          start: (pending) => this.startTurn(message, ask, pending),
        })
        void message.reply(result.reply ?? '').catch(() => undefined)
        return
      }

      // A message sent while a turn is running is a correction: it joins that
      // turn at its next step boundary — after the tool call in flight — rather
      // than starting a second turn to race it over the same session. Commands
      // are never steered: they are not something to say to the model.
      if (!text.startsWith('/') && this.turns.steer(message.channelId, text)) return

      this.startTurn(message, ask, text)
    })

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return
      const customId = interaction.customId
      if (customId.startsWith('perm:')) return // Handled by prompt.awaitMessageComponent in ask()

      if (!isAllowed(this.options.allowlist, [interaction.user.id, interaction.channelId, interaction.guildId])) {
        await interaction.reply({ content: denialMessage(interaction.user.id), ephemeral: true }).catch(() => undefined)
        return
      }

      const context: ActionContext = {
        gateway: 'discord',
        conversationId: interaction.channelId ?? '',
        userId: interaction.user.id,
        messageId: interaction.message?.id,
        answer: async () => {},
        edit: async (content) => {
          const components = toDiscordComponents<ActionRowBuilder<ButtonBuilder>>(content.actions, builders)
          await interaction.update({
            content: content.markdown ?? content.text,
            components,
          }).catch(() => undefined)
        },
      }

      const handled = await actionRouter.dispatch(customId, context).catch(() => false)
      if (handled) return

      // A button no handler knows — an old message, say. Answer it, or Discord shows
      // the person "This interaction failed" for a control it will never resolve.
      await interaction
        .reply({ content: 'This button is no longer available.', ephemeral: true })
        .catch(() => undefined)
    })

    client.once(Events.ClientReady, () => console.error('Discord gateway running'))
    await client.login(this.options.token)
    this.client = client
  }

  /**
   * Puts `text` through the queue as a turn. Not awaited: discord.js dispatches
   * events concurrently, and the queue is what keeps two turns from mutating the
   * same session at once.
   */
  private startTurn(
    message: Message,
    ask: ChannelAsk,
    text: string,
  ): void {
    this.turns.run(message.channelId, (steering, signal) =>
      this.handleTurn(message, text, ask, steering, signal),
    )
  }

  private async handleTurn(
    message: Message,
    text: string,
    ask: ChannelAsk,
    steering: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const scope: MemoryScope = { gateway: 'discord', conversationId: message.channelId }
    const session = await this.options.runtime.sessionFor(scope)

    const display = readDisplay()
    let command: Awaited<ReturnType<typeof handleCommand>>
    try {
      command = await handleCommand(text, {
        policy: this.options.runtime.permissions,
        resetSession: () => session.clear(),
        persistMode: setPermissionMode,
        modeLocked: modeLockMessage(this.options.allowlist),
        sessionLocked: sessionLockMessage(this.options.allowlist),
        display,
        persistDisplay: setDisplay,
        displayLocked: displayLockMessage(this.options.allowlist),
        effort: this.options.runtime.reasoningEffort,
        persistEffort: (effort) => {
          // The running runtime first, so the next turn sends it, then the disk.
          this.options.runtime.setReasoningEffort(effort)
          setReasoningEffort(effort)
        },
        effortLocked: effortLockMessage(this.options.allowlist),
        newSession: (title) => this.options.runtime.newSession(scope, title),
        resumeSession: async (id) => (await this.options.runtime.resumeSession(scope, id)) !== null,
        forkSession: async (targetId, options) => {
          const id = targetId ?? (await this.options.runtime.getSession(scope)).id
          const forked = await this.options.runtime.forkSession(scope, id, options)
          return forked ? { id: forked.id } : null
        },
        listSessions: () => this.options.runtime.listSessions(),
        skills: () => this.options.runtime.skills,
        sessionStats: () => session.stats(),
        compactSession: () => session.compact(signal),
        memories: (limit) => session.memories(limit),
        forgetMemory: (id) => session.forget(id),
        memoryLocked: memoryLockMessage(this.options.allowlist),
      })
    } catch (error) {
      // A command that throws must not swallow the message it was answering.
      await message.reply(`⚠ ${errorMessage(error)}`).catch(() => undefined)
      return
    }
    if (command.handled) {
      // Discord renders Markdown natively, so the richer rendering goes as-is.
      const components = this.builders
        ? toDiscordComponents<ActionRowBuilder<ButtonBuilder>>(command.actions, this.builders)
        : []
      if (components.length > 0) {
        await message.reply({
          content: command.markdown ?? command.reply ?? '',
          components,
        })
      } else {
        await message.reply(command.markdown ?? command.reply ?? '')
      }
      return
    }

    const surface: ChatSurface = {
      post: async (_conversationId, placeholder) => (await message.reply(placeholder)).id,
      edit: async (_conversationId, messageId, value) => {
        const target = await message.channel.messages.fetch(messageId)
        await target.edit(value)
      },
      ask: (_conversationId, _messageId, request) => ask(message, request, signal),
      files: (_conversationId, files) => this.postFiles(message.channelId, files),
      typing: () => this.typing(message.channel),
    }

    const failure = await runTurns({
      session,
      conversationId: message.channelId,
      text,
      surface,
      maxLength: MAX_LENGTH,
      display,
      steering,
      signal,
    })
    // A stop is not a failure, and it is already on screen as "🛑 stopped".
    if (failure) await message.reply(`[error] ${failure}`).catch(() => undefined)
  }

  /**
   * The channel's typing indicator — "Milo is typing…" — kept alive until the
   * returned function is called. Sent and forgotten: a turn must not fail, or
   * slow down, because a status update did.
   *
   * A channel that cannot type at all (a partial group DM, a stage) simply has
   * none to keep alive.
   */
  private typing(channel: object): () => void {
    if (!('sendTyping' in channel)) return () => undefined
    const send = (channel.sendTyping as () => Promise<unknown>).bind(channel)

    const keepAlive = (): void => {
      void send().catch(() => undefined)
    }
    keepAlive()
    const timer = setInterval(keepAlive, TYPING_REFRESH_MS)
    return () => clearInterval(timer)
  }

  async stop(): Promise<void> {
    await this.client?.destroy()
  }

  /**
   * A routine's answer — its text and any files it delivered — posted as its own
   * messages, with no turn behind it. Discord shows a picture from its file
   * attachments directly, so every file rides as one.
   */
  async deliver(conversationId: string, message: OutgoingMessage): Promise<void> {
    const channel = await this.sendable(conversationId)
    const text = message.text ?? ''
    const files = message.files ?? []

    if (files.length === 0) {
      for (const part of chunk(text, MAX_LENGTH)) await channel.send(part)
      return
    }

    const { AttachmentBuilder } = await import('discord.js')
    const parts = chunk(text, MAX_LENGTH)
    for (let index = 0; index < files.length; index += FILES_PER_MESSAGE) {
      const builders = files
        .slice(index, index + FILES_PER_MESSAGE)
        .map((file) => new AttachmentBuilder(file.path, { name: file.name }))
      // The first chunk rides with the first batch of files; anything left over
      // follows as its own messages, so no answer is dropped for its length.
      const content = index === 0 ? parts.shift() : undefined
      await channel.send(content ? { content, files: builders } : { files: builders })
    }
    for (const part of parts) await channel.send(part)
  }

  /**
   * A live turn's own files, posted once the turn is over. The answer is already
   * in the channel, so the files follow it as their own messages.
   */
  private async postFiles(conversationId: string, files: OutgoingFile[]): Promise<void> {
    const channel = await this.sendable(conversationId)
    const { AttachmentBuilder } = await import('discord.js')
    for (let index = 0; index < files.length; index += FILES_PER_MESSAGE) {
      const builders = files
        .slice(index, index + FILES_PER_MESSAGE)
        .map((file) => new AttachmentBuilder(file.path, { name: file.name }))
      await channel.send({ files: builders })
    }
  }

  /** The channel a delivery can be sent to, or a throw saying why it cannot. */
  private async sendable(conversationId: string) {
    const client = this.client
    if (!client) throw new Error('discord gateway is not running')
    const channel = await client.channels.fetch(conversationId)
    if (!channel?.isSendable()) {
      throw new Error(`discord channel ${conversationId} cannot receive messages`)
    }
    return channel
  }
}
