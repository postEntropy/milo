import type { ButtonBuilder, Message } from 'discord.js'
import type { MemoryScope } from '../../core/memory/index.js'
import type { AgentRuntime } from '../../core/runtime.js'
import type { PermissionRequest } from '../../core/tools/permission.js'
import { errorMessage } from '../../util/errors.js'
import { setPermissionMode } from '../../core/config/load.js'
import { denialMessage, isAllowed } from '../access.js'
import { handleCommand, modeLockMessage, sessionLockMessage } from '../commands.js'
import { runTurn } from '../runner.js'
import { TurnQueue } from '../turns.js'
import type { ChatSurface } from '../surface.js'
import type { Gateway } from '../types.js'

export interface DiscordGatewayOptions {
  runtime: AgentRuntime
  token: string
  /** Empty/undefined means anyone may talk to the bot. */
  allowlist?: string[]
}

const ASK_TIMEOUT_MS = 5 * 60 * 1000
const MAX_LENGTH = 1900

export class DiscordGateway implements Gateway {
  readonly id = 'discord' as const
  private client: { destroy: () => Promise<void> } | undefined
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

    const ask = async (target: Message, request: PermissionRequest): Promise<boolean> => {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('perm:allow').setLabel('Allow').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('perm:deny').setLabel('Deny').setStyle(ButtonStyle.Danger),
      )

      const prompt = await target.reply({
        content: `⚠ Allow ${request.tool}?\n\n${request.summary}`,
        components: [row],
      })

      try {
        const interaction = await prompt.awaitMessageComponent({
          time: ASK_TIMEOUT_MS,
          filter: (candidate) => candidate.user.id === target.author.id,
        })
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

      // Not awaited: discord.js dispatches events concurrently, and the queue is
      // what keeps two turns from mutating the same session at once.
      this.turns.run(message.channelId, () => this.handleTurn(message, text, ask))
    })

    client.once(Events.ClientReady, () => console.error('Discord gateway running'))
    await client.login(this.options.token)
    this.client = client
  }

  private async handleTurn(
    message: Message,
    text: string,
    ask: (target: Message, request: PermissionRequest) => Promise<boolean>,
  ): Promise<void> {
    const scope: MemoryScope = { gateway: 'discord', conversationId: message.channelId }
    const session = await this.options.runtime.getSession(scope)

    const command = await handleCommand(text, {
      policy: this.options.runtime.permissions,
      resetSession: () => session.clear(),
      persistMode: setPermissionMode,
      modeLocked: modeLockMessage(this.options.allowlist),
      sessionLocked: sessionLockMessage(this.options.allowlist),
      newSession: (title) => this.options.runtime.newSession(scope, title),
      resumeSession: async (id) => (await this.options.runtime.resumeSession(scope, id)) !== null,
      listSessions: () => this.options.runtime.listSessions(),
      sessionStats: () => session.stats(),
    })
    if (command.handled) {
      // Discord renders Markdown natively, so the richer rendering goes as-is.
      await message.reply(command.markdown ?? command.reply ?? '')
      return
    }

    const surface: ChatSurface = {
      post: async (_conversationId, placeholder) => (await message.reply(placeholder)).id,
      edit: async (_conversationId, messageId, value) => {
        const target = await message.channel.messages.fetch(messageId)
        await target.edit(value)
      },
      ask: (_conversationId, _messageId, request) => ask(message, request),
    }

    try {
      await runTurn({
        session,
        conversationId: message.channelId,
        text,
        surface,
        maxLength: MAX_LENGTH,
      })
    } catch (error) {
      await message.reply(`[error] ${errorMessage(error)}`).catch(() => undefined)
    }
  }

  async stop(): Promise<void> {
    await this.client?.destroy()
  }
}
