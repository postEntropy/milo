import { randomUUID } from 'node:crypto'
import type { Bot, Context } from 'grammy'
import type { MemoryScope } from '../../core/memory/index.js'
import type { AgentRuntime } from '../../core/runtime.js'
import type { PermissionRequest } from '../../core/tools/permission.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import { isTelegramPhoto, type OutgoingFile, type OutgoingMessage } from '../../core/outgoing.js'
import { readDisplay } from '../../core/config/load.js'
import { denialMessage, isAllowed } from '../access.js'
import { chunk } from '../chunk.js'
import {
  buildCommandContext,
  decodePermission,
  encodePermission,
  handleCommand,
  handleTurnControl,
  parseTurnControl,
  turnOf,
  type CommandResult,
} from '../commands.js'
import { PendingDecisions } from '../pending.js'
import { runTurns } from '../runner.js'
import { TurnQueue } from '../turns.js'
import type { ChatSurface } from '../surface.js'
import type { Gateway } from '../types.js'
import type { IncomingFile } from '../../core/media.js'
import type { ImagePart } from '../../core/providers/types.js'
import { TelegramMessenger, isNotModified } from './messenger.js'
import { commandReplyParts } from './reply.js'
import { toHtml, toPlain } from './html.js'
import {
  ActionRouter,
  DISABLED_CALLBACK,
  buildSessionsList,
  toTelegramKeyboard,
  type ActionContext,
} from '../actions.js'

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

    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      if (data === DISABLED_CALLBACK) {
        await ctx.answerCallbackQuery().catch(() => undefined)
        return
      }
      const chatId = String(ctx.chat?.id ?? '')
      const messageId = ctx.callbackQuery.message?.message_id

      if (!isAllowed(this.options.allowlist, [ctx.from?.id, ctx.chat?.id])) {
        await ctx.answerCallbackQuery({ text: 'Access denied' }).catch(() => undefined)
        return
      }

      const context: ActionContext = {
        gateway: 'telegram',
        conversationId: chatId,
        userId: String(ctx.from?.id ?? ''),
        messageId: messageId !== undefined ? String(messageId) : undefined,
        answer: async (text) => {
          await ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => undefined)
        },
        edit: async (content) => {
          if (messageId === undefined) return
          const replyMarkup = toTelegramKeyboard(content.actions)
          const html = toHtml(content.markdown ?? content.text)
          await bot.api
            .editMessageText(chatId, messageId, html, {
              parse_mode: 'HTML',
              reply_markup: replyMarkup,
            })
            .catch(() => undefined)
        },
      }

      const handled = await actionRouter.dispatch(data, context).catch(() => false)
      if (handled) {
        await context.answer().catch(() => undefined)
        return
      }

      const parsed = decodePermission(data)
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
        void this.reply(bot, chatId, result).catch(() => undefined)
        return
      }

      // A message sent while a turn is running is a correction: it joins that
      // turn at its next step boundary — after the tool call in flight — rather
      // than starting a second turn to race it over the same session. Commands
      // are never steered: they are not something to say to the model.
      if (!text.startsWith('/') && this.turns.steer(chatId, text)) return

      this.startTurn(bot, ctx, chatId, text)
    })

    bot.on('message:photo', (ctx) => { void this.receiveTelegramMedia(bot, ctx, ctx.msg.photo.at(-1)?.file_id, 'image/jpeg', 'photo.jpg') })
    bot.on('message:document', (ctx) => { void this.receiveTelegramMedia(bot, ctx, ctx.msg.document.file_id, ctx.msg.document.mime_type ?? 'application/octet-stream', ctx.msg.document.file_name ?? 'document') })
    bot.on('message:audio', (ctx) => { void this.receiveTelegramMedia(bot, ctx, ctx.msg.audio.file_id, ctx.msg.audio.mime_type ?? 'audio/mpeg', ctx.msg.audio.file_name ?? 'audio') })
    bot.on('message:voice', (ctx) => { void this.receiveTelegramMedia(bot, ctx, ctx.msg.voice.file_id, ctx.msg.voice.mime_type ?? 'audio/ogg', 'voice.ogg') })

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

  private async receiveTelegramMedia(bot: Bot, ctx: Context, fileId: string | undefined, mimeType: string, name: string): Promise<void> {
    const chatId = String(ctx.chat?.id ?? '')
    if (!fileId || !chatId) return
    if (!isAllowed(this.options.allowlist, [ctx.from?.id, ctx.chat?.id])) {
      await ctx.reply(denialMessage(ctx.from?.id ?? ctx.chat?.id ?? 'user'))
      return
    }
    try {
      const file = await bot.api.getFile(fileId)
      if (!file.file_path) throw new Error('Telegram did not return a download path.')
      const response = await fetch(`https://api.telegram.org/file/bot${this.options.token}/${file.file_path}`)
      if (!response.ok) throw new Error(`Telegram download failed (${response.status}).`)
      const incoming: IncomingFile[] = [{ name, mimeType, data: new Uint8Array(await response.arrayBuffer()) }]
      const caption = ctx.msg && 'caption' in ctx.msg ? String(ctx.msg.caption ?? '') : ''
      this.startMediaTurn(bot, ctx, chatId, caption || 'Please inspect the attached media.', incoming)
    } catch (error) {
      await ctx.reply(`Could not read that attachment: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private startMediaTurn(bot: Bot, ctx: Context, chatId: string, text: string, files: IncomingFile[]): void {
    this.turns.run(chatId, (steering, signal) => this.handleTurn(bot, ctx, chatId, text, steering, signal, [], files))
  }

  private async handleTurn(
    bot: Bot,
    ctx: Context,
    chatId: string,
    text: string,
    steering: string[],
    signal: AbortSignal,
    images: ImagePart[] = [],
    files?: IncomingFile[],
  ): Promise<void> {
    const scope: MemoryScope = { gateway: 'telegram', conversationId: chatId }
    const session = await this.options.runtime.sessionFor(scope)

    let command: Awaited<ReturnType<typeof handleCommand>>
    try {
      command = files?.length
        ? { handled: false }
        : await handleCommand(
            text,
            buildCommandContext({
              runtime: this.options.runtime,
              scope,
              session,
              allowlist: this.options.allowlist,
              // Who is asking decides whether the single-person lock opens: an
              // allowlist naming this chat is a room, and a room is not one person.
              userId: ctx.from?.id === undefined ? undefined : String(ctx.from.id),
              signal,
            }),
          )
    } catch (error) {
      // A command that throws must not swallow the message it was answering.
      for (const part of chunk(`⚠ ${errorMessage(error)}`, MAX_LENGTH)) {
        await ctx.reply(part).catch(() => undefined)
      }
      return
    }
    if (command.handled) {
      await this.reply(bot, chatId, command)
      return
    }

    const messenger = new TelegramMessenger({
      sendHtml: async (chat, html) =>
        (await bot.api.sendMessage(chat, html, { parse_mode: 'HTML' })).message_id,
      sendPlain: async (chat, text) => (await bot.api.sendMessage(chat, text)).message_id,
      editHtml: async (chat, messageId, html) => {
        try {
          await bot.api.editMessageText(chat, messageId, html, { parse_mode: 'HTML' })
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
        await messenger.edit(chatId, Number(messageId), value).catch((error) => {
          logWarn(`telegram: could not edit message ${messageId}: ${errorMessage(error)}`)
        })
      },
      ask: (_conversationId, _messageId, request) => this.ask(bot, chatId, request, signal),
      files: (_conversationId, files) => this.postFiles(chatId, files),
      typing: () => this.typing(bot, chatId),
    }

    const display = readDisplay()
    const failure = await runTurns({
      session,
      conversationId: chatId,
      text,
      surface,
      maxLength: MAX_LENGTH,
      display,
      steering,
      signal,
      images,
      files,
    })
    // A stop is not a failure, and it is already on screen as "🛑 stopped".
    if (failure) {
      for (const part of chunk(`[error] ${failure}`, MAX_LENGTH)) {
        await ctx
          .reply(part)
          .catch((err) => logWarn(`telegram: failed to send error reply: ${errorMessage(err)}`))
      }
    }
  }

  /**
   * Most command replies are plain text. A few — `/sessions` — also come with a
   * Markdown rendering, which goes out as an ordinary message in HTML and falls
   * back to the words alone when the API refuses it. Either way it is split to
   * the message limit, because a command reply can outgrow one message.
   *
   * The fallback resumes at the part that failed. Sending the whole reply again
   * as plain would repeat every part already delivered, which is what the person
   * sees as the same paragraphs arriving twice.
   */
  private async reply(
    bot: Bot,
    chatId: string,
    command: CommandResult,
  ): Promise<void> {
    const { parts, markdown } = commandReplyParts(command, MAX_LENGTH)
    const replyMarkup = toTelegramKeyboard(command.actions)
    let html = markdown
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const isLast = i === parts.length - 1
      const reply_markup = isLast && replyMarkup ? replyMarkup : undefined
      if (html) {
        try {
          await bot.api.sendMessage(chatId, toHtml(part), { parse_mode: 'HTML', reply_markup })
          continue
        } catch {
          // The API refused the markup. What already went out stays as it is; the
          // rest of the reply goes as the words alone, never raw Markdown.
          html = false
        }
      }
      await bot.api.sendMessage(chatId, toPlain(part), { reply_markup })
    }
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

    // A caption under a file is capped at 1024. A longer answer is not cut to fit
    // under a picture: the files go first, then the answer as its own messages.
    const trimmed = text.trim()
    const caption = trimmed.length > 0 && trimmed.length <= CAPTION_MAX ? trimmed : ''
    for (const [index, file] of files.entries()) {
      const first = index === 0
      await this.sendFile(bot, conversationId, file, first ? (file.caption ?? caption) : file.caption)
    }
    if (!caption && trimmed) {
      for (const part of chunk(text, MAX_LENGTH)) await bot.api.sendMessage(conversationId, part)
    }
  }

  /**
   * A live turn's own files, posted once the turn is over. The answer is already
   * in the chat, so each file rides with its own caption rather than the reply's
   * text — which the turn has already sent.
   */
  private async postFiles(chatId: string, files: OutgoingFile[]): Promise<void> {
    const bot = this.bot
    if (!bot) throw new Error('telegram gateway is not running')
    for (const file of files) await this.sendFile(bot, chatId, file, file.caption)
  }

  /**
   * One file: a photo when Telegram takes that format, a document otherwise. A
   * picture Telegram refuses still goes as a document, under the same name.
   */
  private async sendFile(
    bot: Bot,
    chatId: string,
    file: OutgoingFile,
    caption?: string,
  ): Promise<void> {
    const { InputFile } = await import('grammy')
    const options = caption ? { caption } : {}
    if (!isTelegramPhoto(file.mimeType)) {
      await bot.api.sendDocument(chatId, new InputFile(file.path, file.name), options)
      return
    }
    try {
      await bot.api.sendPhoto(chatId, new InputFile(file.path, file.name), options)
    } catch {
      // A picture Telegram refuses — an oversized PNG, a format it will not take
      // as a photo — still goes as a document. The first `InputFile` was spent on
      // the refusal, so this one is built afresh.
      await bot.api.sendDocument(chatId, new InputFile(file.path, file.name), options)
    }
  }
}
