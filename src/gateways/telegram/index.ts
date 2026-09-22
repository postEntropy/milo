import { randomUUID } from 'node:crypto'
import type { Bot, Context } from 'grammy'
import type { MemoryScope } from '../../core/memory/index.js'
import type { AgentRuntime } from '../../core/runtime.js'
import type { PermissionRequest } from '../../core/tools/permission.js'
import { errorMessage } from '../../util/errors.js'
import { setPermissionMode } from '../../core/config/load.js'
import { denialMessage, isAllowed } from '../access.js'
import {
  decodePermission,
  encodePermission,
  handleCommand,
  modeLockMessage,
  sessionLockMessage,
  type CommandResult,
} from '../commands.js'
import { PendingDecisions } from '../pending.js'
import { runTurn } from '../runner.js'
import { TurnQueue } from '../turns.js'
import type { ChatSurface } from '../surface.js'
import type { Gateway } from '../types.js'
import { RichMessenger, isNotModified } from './rich.js'

export interface TelegramGatewayOptions {
  runtime: AgentRuntime
  token: string
  /** Empty/undefined means anyone may talk to the bot. */
  allowlist?: string[]
}

const ASK_TIMEOUT_MS = 5 * 60 * 1000
const MAX_LENGTH = 4000

export class TelegramGateway implements Gateway {
  readonly id = 'telegram' as const
  private bot: Bot | undefined
  private readonly pending = new PendingDecisions()
  private readonly turns = new TurnQueue()

  constructor(private readonly options: TelegramGatewayOptions) {}

  async start(): Promise<void> {
    const { Bot: TelegramBot } = await import('grammy')
    const bot = new TelegramBot(this.options.token)

    // Otherwise the client suggests /start, which Milo does not have.
    await bot.api
      .setMyCommands([
        { command: 'help', description: 'Show the available commands' },
        { command: 'new', description: 'Start a new session' },
        { command: 'sessions', description: 'List saved sessions' },
        { command: 'resume', description: 'Switch to another session: /resume <id>' },
        { command: 'stats', description: 'Numbers for the current session' },
        { command: 'mode', description: 'Permission mode: ask, auto or yolo' },
        { command: 'yolo', description: 'Toggle yolo mode' },
        { command: 'clear', description: 'Forget this conversation' },
        { command: 'status', description: 'Show the current permission mode' },
      ])
      .catch(() => undefined)

    bot.on('callback_query:data', async (ctx) => {
      const parsed = decodePermission(ctx.callbackQuery.data)
      if (!parsed) {
        await ctx.answerCallbackQuery().catch(() => undefined)
        return
      }
      const known = this.pending.resolve(parsed.id, parsed.allowed)
      await ctx
        .answerCallbackQuery({ text: known ? (parsed.allowed ? 'Allowed' : 'Denied') : 'Expired' })
        .catch(() => undefined)
      if (known) {
        await ctx
          .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
          .catch(() => undefined)
      }
    })

    bot.on('message:text', (ctx) => {
      const chatId = String(ctx.chat.id)
      const text = ctx.msg.text

      if (!isAllowed(this.options.allowlist, [ctx.from?.id, ctx.chat.id])) {
        // Fire and forget: the update loop must not wait on a network call.
        void ctx.reply(denialMessage(ctx.from?.id ?? ctx.chat.id)).catch(() => undefined)
        return
      }

      // Deliberately not awaited. The turn blocks on the permission button
      // below, and simple long polling handles updates one at a time, so
      // awaiting it here would keep the button press queued behind the very
      // turn waiting for it.
      this.turns.run(chatId, () => this.handleTurn(bot, ctx, chatId, text))
    })

    this.bot = bot
    bot
      .start({ onStart: () => console.error('Telegram gateway running') })
      .catch((error: unknown) => console.error(`Telegram gateway stopped: ${errorMessage(error)}`))
  }

  private async handleTurn(bot: Bot, ctx: Context, chatId: string, text: string): Promise<void> {
    const scope: MemoryScope = { gateway: 'telegram', conversationId: chatId }
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
      await this.reply(bot, ctx, chatId, command)
      return
    }

    const messenger = new RichMessenger({
      sendRich: async (chat, markdown) =>
        (await bot.api.sendRichMessage(chat, { markdown })).message_id,
      sendPlain: async (chat, text) => (await bot.api.sendMessage(chat, text)).message_id,
      editRich: async (chat, messageId, markdown) => {
        try {
          await bot.api.editMessageText(chat, messageId, { markdown })
        } catch (error) {
          if (!isNotModified(error)) throw error
        }
      },
      editPlain: async (chat, messageId, text) => {
        await bot.api.editMessageText(chat, messageId, text)
      },
    })

    const surface: ChatSurface = {
      post: async (_conversationId, placeholder) =>
        String(await messenger.post(chatId, placeholder)),
      edit: async (_conversationId, messageId, value) => {
        await messenger.edit(chatId, Number(messageId), value).catch(() => undefined)
      },
      ask: (_conversationId, _messageId, request) => this.ask(bot, chatId, request),
    }

    try {
      await runTurn({
        session,
        conversationId: chatId,
        text,
        surface,
        maxLength: MAX_LENGTH,
      })
    } catch (error) {
      await ctx.reply(`[error] ${errorMessage(error)}`).catch(() => undefined)
    }
  }

  /**
   * Most command replies are plain text. A few — `/sessions` — also come with a
   * Markdown rendering, which goes out as a rich message and falls back to the
   * plain text when the API refuses it.
   */
  private async reply(
    bot: Bot,
    ctx: Context,
    chatId: string,
    command: CommandResult,
  ): Promise<void> {
    if (command.markdown) {
      try {
        await bot.api.sendRichMessage(chatId, { markdown: command.markdown })
        return
      } catch {
        // Fall through to the plain text, which never trips on Markdown syntax.
      }
    }
    await ctx.reply(command.reply ?? '')
  }

  private async ask(bot: Bot, chatId: string, request: PermissionRequest): Promise<boolean> {
    const id = randomUUID()
    try {
      await bot.api.sendMessage(chatId, `⚠ Allow ${request.tool}?\n\n${request.summary}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Allow', callback_data: encodePermission(id, true) },
              { text: '🚫 Deny', callback_data: encodePermission(id, false) },
            ],
          ],
        },
      })
    } catch {
      return false
    }
    return this.pending.wait(id, ASK_TIMEOUT_MS)
  }

  async stop(): Promise<void> {
    await this.bot?.stop()
  }
}
