import { randomUUID } from 'node:crypto'
import type { Bot, Context } from 'grammy'
import type { MemoryScope } from '../../core/memory/index.js'
import type { AgentRuntime } from '../../core/runtime.js'
import type { PermissionRequest } from '../../core/tools/permission.js'
import { errorMessage } from '../../util/errors.js'
import { isTelegramPhoto, type OutgoingMessage } from '../../core/outgoing.js'
import { readDisplay, setDisplay, setPermissionMode, setReasoningEffort } from '../../core/config/load.js'
import { denialMessage, isAllowed } from '../access.js'
import { chunk } from '../chunk.js'
import {
  decodePermission,
  encodePermission,
  effortLockMessage,
  handleCommand,
  handleTurnControl,
  memoryLockMessage,
  modeLockMessage,
  parseTurnControl,
  sessionLockMessage,
  turnOf,
  displayLockMessage,
  type CommandResult,
} from '../commands.js'
import { PendingDecisions } from '../pending.js'
import { runTurns } from '../runner.js'
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
/** Telegram caps a file's caption at 1024 characters; longer text goes as its own messages. */
const CAPTION_MAX = 1024

/**
 * Telegram's chat action expires after about five seconds and nothing renews it,
 * so the indicator is refreshed just inside that window while a turn runs.
 */
const TYPING_REFRESH_MS = 4_000

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
        { command: 'compact', description: 'Fold the oldest turns into the summary now' },
        { command: 'stop', description: 'Stop the turn running now' },
        { command: 'steer', description: 'Add to the turn running now: /steer <text>' },
        { command: 'queue', description: 'Say it after this turn: /queue <text>' },
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

      // `/stop`, `/steer` and `/queue` are about the turn itself, so they are
      // answered here rather than inside one: a `/stop` that waited for the turn
      // it is meant to stop would arrive after it. Not awaited — the reply is one
      // API call, and the turn it starts goes through the queue like any message.
      if (parseTurnControl(text)) {
        const result = handleTurnControl(text, {
          turn: turnOf(this.turns, chatId),
          start: (pending) => this.startTurn(bot, ctx, chatId, pending),
        })
        void this.reply(bot, ctx, chatId, result).catch(() => undefined)
        return
      }

      // A message sent while a turn is running is a correction: it joins that
      // turn at its next step boundary — after the tool call in flight — rather
      // than starting a second turn to race it over the same session. Commands
      // are never steered: they are not something to say to the model.
      if (!text.startsWith('/') && this.turns.steer(chatId, text)) return

      this.startTurn(bot, ctx, chatId, text)
    })

    this.bot = bot
    bot
      .start({ onStart: () => console.error('Telegram gateway running') })
      .catch((error: unknown) => console.error(`Telegram gateway stopped: ${errorMessage(error)}`))
  }

  /**
   * Puts `text` through the queue as a turn. Deliberately not awaited: the turn
   * blocks on the permission button, and simple long polling handles updates one
   * at a time, so awaiting it here would keep the button press queued behind the
   * very turn waiting for it.
   */
  private startTurn(bot: Bot, ctx: Context, chatId: string, text: string): void {
    this.turns.run(chatId, (steering, signal) =>
      this.handleTurn(bot, ctx, chatId, text, steering, signal),
    )
  }

  private async handleTurn(
    bot: Bot,
    ctx: Context,
    chatId: string,
    text: string,
    steering: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const scope: MemoryScope = { gateway: 'telegram', conversationId: chatId }
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
      await ctx.reply(`⚠ ${errorMessage(error)}`).catch(() => undefined)
      return
    }
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
      ask: (_conversationId, _messageId, request) => this.ask(bot, chatId, request, signal),
      typing: () => this.typing(bot, chatId),
    }

    const failure = await runTurns({
      session,
      conversationId: chatId,
      text,
      surface,
      maxLength: MAX_LENGTH,
      display,
      steering,
      signal,
    })
    // A stop is not a failure, and it is already on screen as "🛑 stopped".
    if (failure) await ctx.reply(`[error] ${failure}`).catch(() => undefined)
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

  /**
   * The chat action that says Milo is working, kept alive until the returned
   * function is called. Sent and forgotten: a turn must not fail, or slow down,
   * because a status update did.
   */
  private typing(bot: Bot, chatId: string): () => void {
    const keepAlive = (): void => {
      void bot.api.sendChatAction(chatId, 'typing').catch(() => undefined)
    }
    keepAlive()
    const timer = setInterval(keepAlive, TYPING_REFRESH_MS)
    return () => clearInterval(timer)
  }

  private async ask(
    bot: Bot,
    chatId: string,
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const id = randomUUID()
    let promptId: number | undefined
    try {
      const prompt = await bot.api.sendMessage(chatId, `⚠ Allow ${request.tool}?\n\n${request.summary}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Allow', callback_data: encodePermission(id, true) },
              { text: '🚫 Deny', callback_data: encodePermission(id, false) },
            ],
          ],
        },
      })
      promptId = prompt.message_id
    } catch {
      return false
    }

    const allowed = await this.pending.wait(id, ASK_TIMEOUT_MS, signal)
    if (signal?.aborted && promptId !== undefined) {
      // The id is spent, so a tap answers "Expired" — but the buttons should not
      // be left there inviting a tap that a stopped turn must not honour.
      await bot.api
        .editMessageReplyMarkup(chatId, promptId, { reply_markup: { inline_keyboard: [] } })
        .catch(() => undefined)
    }
    return allowed
  }

  async stop(): Promise<void> {
    await this.bot?.stop()
  }

  /**
   * A routine's answer — its text and any files it delivered — posted as its own
   * messages, with no turn behind it. A picture goes as a photo so it shows in
   * the chat; anything else goes as a document, which is a download rather than a
   * preview but arrives the same.
   */
  async deliver(conversationId: string, message: OutgoingMessage): Promise<void> {
    const bot = this.bot
    if (!bot) throw new Error('telegram gateway is not running')
    const text = message.text ?? ''
    const files = message.files ?? []

    if (files.length === 0) {
      for (const part of chunk(text, MAX_LENGTH)) await bot.api.sendMessage(conversationId, part)
      return
    }

    const { InputFile } = await import('grammy')
    // A caption under a file is capped at 1024. A longer answer is not cut to fit
    // under a picture: the files go first, then the answer as its own messages.
    const trimmed = text.trim()
    const caption = trimmed.length > 0 && trimmed.length <= CAPTION_MAX ? trimmed : ''
    for (const [index, file] of files.entries()) {
      const first = index === 0
      const line = first ? (file.caption ?? caption) : file.caption
      const options = line ? { caption: line } : {}
      const photo = isTelegramPhoto(file.mimeType)
      if (!photo) {
        await bot.api.sendDocument(conversationId, new InputFile(file.path, file.name), options)
        continue
      }
      try {
        await bot.api.sendPhoto(conversationId, new InputFile(file.path, file.name), options)
      } catch {
        // A picture Telegram refuses — an oversized PNG, a format it will not
        // take as a photo — still goes as a document. The first `InputFile` was
        // spent on the refusal, so this one is built afresh.
        await bot.api.sendDocument(conversationId, new InputFile(file.path, file.name), options)
      }
    }
    if (!caption && trimmed) {
      for (const part of chunk(text, MAX_LENGTH)) await bot.api.sendMessage(conversationId, part)
    }
  }
}
