import {
  DEFAULT_PAGE_SIZE,
  formatSessionList,
  formatWhen,
  summarizeRecap,
  type SessionSummary,
} from '../core/sessions/index.js'
import type {
  ActionButton,
  ActionRow,
  SessionCardItem,
} from './web/protocol.js'

export type {
  ActionButton,
  ActionButtonStyle,
  ActionRow,
  SessionCardItem,
} from './web/protocol.js'

/**
 * Context passed to an action handler when a button is clicked.
 */
export interface ActionContext {
  gateway: 'telegram' | 'discord' | 'web' | 'cli'
  conversationId: string
  userId?: string
  messageId?: string
  /** Acknowledge the interaction (e.g. answerCallbackQuery in Telegram) */
  answer(text?: string): Promise<void>
  /** Edit the original message in place with updated content & actions */
  edit(content: { text: string; markdown?: string; actions?: ActionRow[] }): Promise<void>
}

export type ActionHandler = (payload: string, context: ActionContext) => Promise<void>

/**
 * Router that dispatches button clicks by prefix:
 * e.g. "sessions:2" calls the handler for "sessions" with payload "2".
 */
export class ActionRouter {
  private readonly handlers = new Map<string, ActionHandler>()

  on(prefix: string, handler: ActionHandler): this {
    this.handlers.set(prefix, handler)
    return this
  }

  async dispatch(actionId: string, context: ActionContext): Promise<boolean> {
    const colonIndex = actionId.indexOf(':')
    const prefix = colonIndex === -1 ? actionId : actionId.slice(0, colonIndex)
    const payload = colonIndex === -1 ? '' : actionId.slice(colonIndex + 1)

    const handler = this.handlers.get(prefix)
    if (!handler) return false

    await handler(payload, context)
    return true
  }
}

/**
 * Creates standard pagination buttons: [ ◀ Prev ] [ 1/3 ] [ Next ▶ ].
 * The middle indicator is marked disabled so chat surfaces do not treat it as an actionable button.
 */
export function paginationActions(
  prefix: string,
  page: number,
  totalPages: number,
  labels?: { prev?: string; next?: string },
): ActionRow | undefined {
  if (totalPages <= 1) return undefined
  const prevLabel = labels?.prev ?? '◀ Prev'
  const nextLabel = labels?.next ?? 'Next ▶'
  const row: ActionButton[] = []

  if (page > 1) {
    row.push({ id: `${prefix}:${page - 1}`, label: prevLabel, style: 'default' })
  }
  row.push({ id: `${prefix}:${page}`, label: `${page}/${totalPages}`, style: 'default', disabled: true })
  if (page < totalPages) {
    row.push({ id: `${prefix}:${page + 1}`, label: nextLabel, style: 'default' })
  }
  return row
}

export interface SessionsListResult {
  reply: string
  markdown: string
  actions?: ActionRow[]
  cards: SessionCardItem[]
  pagination: {
    page: number
    totalPages: number
    totalItems: number
    pageSize: number
  }
}

/**
 * Either a page of sessions, or why the requested page is unusable. A union so a
 * caller cannot drop the error on the floor and leave the person with silence.
 */
export type SessionsListOutcome =
  | { ok: true; result: SessionsListResult }
  | { ok: false; error: string }

/**
 * The one builder for `/sessions`, shared by the CLI and every chat gateway: it
 * validates the page argument and derives the plain reply, the Markdown one, the
 * pagination row and the rich cards in a single place, so no surface invents its own.
 */
export function buildSessionsList(
  sessions: SessionSummary[],
  pageArg?: string | number,
  pageSize = DEFAULT_PAGE_SIZE,
): SessionsListOutcome {
  const totalPages = Math.max(1, Math.ceil(sessions.length / pageSize))
  let page = 1

  if (pageArg !== undefined && pageArg !== '') {
    const asked = typeof pageArg === 'number' ? String(pageArg) : pageArg.trim()
    const raw = Number(asked)
    if (!Number.isInteger(raw) || raw < 1) {
      return { ok: false, error: `Invalid page: "${pageArg}". Use /sessions 1..${totalPages}` }
    }
    page = raw
  }

  const currentPage = Math.min(page, totalPages)
  const offset = (currentPage - 1) * pageSize
  const pageSessions = sessions.slice(offset, offset + pageSize)
  const cards: SessionCardItem[] = pageSessions.map((s) => ({
    id: s.id,
    title: s.title,
    messageCount: s.messageCount,
    when: formatWhen(s.updatedAt),
    summary: summarizeRecap(s.recap, s.preview),
  }))

  const paginationRow = paginationActions('sessions', currentPage, totalPages)
  const actions: ActionRow[] = paginationRow ? [paginationRow] : []

  return {
    ok: true,
    result: {
      reply: formatSessionList(sessions, { page: currentPage, pageSize }),
      markdown: formatSessionList(sessions, { markdown: true, page: currentPage, pageSize }),
      actions: actions.length > 0 ? actions : undefined,
      cards,
      pagination: {
        page: currentPage,
        totalPages,
        totalItems: sessions.length,
        pageSize,
      },
    },
  }
}

export type TelegramInlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][]
}

/**
 * Telegram has no disabled buttons, so a disabled one is sent with a callback nobody
 * handles: it looks inert, and tapping it only closes the spinner.
 */
export const DISABLED_CALLBACK = 'noop'

/**
 * Converts ActionRow[] into Telegram's inline_keyboard markup.
 */
export function toTelegramKeyboard(rows?: ActionRow[]): TelegramInlineKeyboard | undefined {
  if (!rows || rows.length === 0) return undefined
  const keyboard = rows.map((row) =>
    row.map((btn): TelegramInlineButton => {
      if (btn.url) return { text: btn.label, url: btn.url }
      if (btn.disabled) return { text: btn.label, callback_data: DISABLED_CALLBACK }
      return { text: btn.label, callback_data: btn.id }
    }),
  )
  return { inline_keyboard: keyboard }
}

export interface DiscordButtonInstance {
  setLabel(label: string): this
  setURL(url: string): this
  setCustomId(id: string): this
  setStyle(style: unknown): this
  setDisabled?(disabled: boolean): this
}

export interface DiscordBuilders {
  ActionRowBuilder: new () => { addComponents(...components: unknown[]): unknown }
  ButtonBuilder: new () => DiscordButtonInstance
  ButtonStyle: {
    Primary: unknown
    Secondary: unknown
    Success: unknown
    Danger: unknown
    Link: unknown
  }
}

/**
 * Converts ActionRow[] into Discord's ActionRowBuilder<ButtonBuilder>[] components.
 */
export function toDiscordComponents<T = unknown>(
  rows: ActionRow[] | undefined,
  builders: DiscordBuilders,
): T[] {
  if (!rows || rows.length === 0) return []
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = builders

  return rows.map((row) => {
    const actionRow = new ActionRowBuilder()
    for (const btn of row) {
      const button = new ButtonBuilder().setLabel(btn.label)
      if (btn.url) {
        button.setURL(btn.url).setStyle(ButtonStyle.Link)
      } else {
        button.setCustomId(btn.id)
        switch (btn.style) {
          case 'primary':
            button.setStyle(ButtonStyle.Primary)
            break
          case 'success':
            button.setStyle(ButtonStyle.Success)
            break
          case 'danger':
            button.setStyle(ButtonStyle.Danger)
            break
          default:
            button.setStyle(ButtonStyle.Secondary)
            break
        }
      }
      if (btn.disabled && typeof button.setDisabled === 'function') {
        button.setDisabled(true)
      }
      actionRow.addComponents(button)
    }
    return actionRow as T
  })
}
