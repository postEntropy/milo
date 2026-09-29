import { describe, expect, it, vi } from 'vitest'
import {
  ActionRouter,
  buildSessionsList,
  paginationActions,
  toDiscordComponents,
  toTelegramKeyboard,
  type ActionContext,
} from '../src/gateways/actions.js'
import type { SessionSummary } from '../src/core/sessions/index.js'

describe('ActionRouter', () => {
  it('dispatches to the registered prefix handler with payload', async () => {
    const router = new ActionRouter()
    const handler = vi.fn(async () => {})
    router.on('sessions', handler)

    const context: ActionContext = {
      gateway: 'telegram',
      conversationId: '123',
      answer: vi.fn(async () => {}),
      edit: vi.fn(async () => {}),
    }

    const handled = await router.dispatch('sessions:2', context)
    expect(handled).toBe(true)
    expect(handler).toHaveBeenCalledWith('2', context)
  })

  it('handles action without payload', async () => {
    const router = new ActionRouter()
    const handler = vi.fn(async () => {})
    router.on('reset', handler)

    const context: ActionContext = {
      gateway: 'discord',
      conversationId: '456',
      answer: vi.fn(async () => {}),
      edit: vi.fn(async () => {}),
    }

    const handled = await router.dispatch('reset', context)
    expect(handled).toBe(true)
    expect(handler).toHaveBeenCalledWith('', context)
  })

  it('returns false for unknown prefix', async () => {
    const router = new ActionRouter()
    const context: ActionContext = {
      gateway: 'web',
      conversationId: '789',
      answer: vi.fn(async () => {}),
      edit: vi.fn(async () => {}),
    }

    const handled = await router.dispatch('unknown:action', context)
    expect(handled).toBe(false)
  })
})

describe('paginationActions', () => {
  it('returns undefined when there is only one page', () => {
    expect(paginationActions('sessions', 1, 1)).toBeUndefined()
  })

  it('generates next button on page 1 of multiple pages', () => {
    const row = paginationActions('sessions', 1, 3)
    expect(row).toEqual([
      { id: 'sessions:1', label: '1/3', style: 'default', disabled: true },
      { id: 'sessions:2', label: 'Next ▶', style: 'default' },
    ])
  })

  it('generates prev and next buttons on middle page', () => {
    const row = paginationActions('sessions', 2, 3)
    expect(row).toEqual([
      { id: 'sessions:1', label: '◀ Prev', style: 'default' },
      { id: 'sessions:2', label: '2/3', style: 'default', disabled: true },
      { id: 'sessions:3', label: 'Next ▶', style: 'default' },
    ])
  })

  it('generates only prev button on last page', () => {
    const row = paginationActions('sessions', 3, 3)
    expect(row).toEqual([
      { id: 'sessions:2', label: '◀ Prev', style: 'default' },
      { id: 'sessions:3', label: '3/3', style: 'default', disabled: true },
    ])
  })
})

describe('buildSessionsList', () => {
  const now = Date.now()
  const dummySessions: SessionSummary[] = Array.from({ length: 12 }, (_, i) => ({
    id: `sess-${i + 1}`,
    title: `Session ${i + 1}`,
    createdAt: now - (i + 1) * 60000,
    updatedAt: now - i * 60000,
    messageCount: (i + 1) * 2,
    preview: `Preview ${i + 1}`,
  }))

  it('returns formatted page and actions for valid page', () => {
    const outcome = buildSessionsList(dummySessions, 1, 5)
    if (!outcome.ok) throw new Error(`expected a page, got: ${outcome.error}`)
    expect(outcome.result.pagination).toEqual({
      page: 1,
      totalPages: 3,
      totalItems: 12,
      pageSize: 5,
    })
    expect(outcome.result.cards).toHaveLength(5)
    expect(outcome.result.cards[0].id).toBe('sess-1')
    expect(outcome.result.cards[0].when).toBeDefined()
    expect(outcome.result.actions).toBeDefined()
    expect(outcome.result.actions?.[0]).toEqual([
      { id: 'sessions:1', label: '1/3', style: 'default', disabled: true },
      { id: 'sessions:2', label: 'Next ▶', style: 'default' },
    ])
  })

  it('treats a missing page argument as page 1', () => {
    const outcome = buildSessionsList(dummySessions)
    if (!outcome.ok) throw new Error(`expected a page, got: ${outcome.error}`)
    expect(outcome.result.pagination.page).toBe(1)
  })

  it('returns error on invalid page string', () => {
    expect(buildSessionsList(dummySessions, 'abc', 5)).toEqual({
      ok: false,
      error: 'Invalid page: "abc". Use /sessions 1..3',
    })
  })

  it('returns error on zero or negative page string', () => {
    expect(buildSessionsList(dummySessions, '0', 5)).toEqual({
      ok: false,
      error: 'Invalid page: "0". Use /sessions 1..3',
    })
    expect(buildSessionsList(dummySessions, '-2', 5)).toEqual({
      ok: false,
      error: 'Invalid page: "-2". Use /sessions 1..3',
    })
  })
})

describe('toTelegramKeyboard', () => {
  it('returns undefined for empty/undefined rows', () => {
    expect(toTelegramKeyboard()).toBeUndefined()
    expect(toTelegramKeyboard([])).toBeUndefined()
  })

  it('converts action rows to telegram inline keyboard format', () => {
    const keyboard = toTelegramKeyboard([
      [
        { id: 'sessions:1', label: '1/3', disabled: true },
        { id: 'sessions:2', label: 'Page 2' },
        { id: 'link', label: 'Docs', url: 'https://example.com' },
      ],
    ])
    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          { text: '1/3', callback_data: 'noop' },
          { text: 'Page 2', callback_data: 'sessions:2' },
          { text: 'Docs', url: 'https://example.com' },
        ],
      ],
    })
  })
})

describe('toDiscordComponents', () => {
  class MockButtonBuilder {
    data: Record<string, unknown> = {}
    setLabel(label: string) {
      this.data.label = label
      return this
    }
    setCustomId(id: string) {
      this.data.customId = id
      return this
    }
    setURL(url: string) {
      this.data.url = url
      return this
    }
    setStyle(style: unknown) {
      this.data.style = style
      return this
    }
    setDisabled(disabled: boolean) {
      this.data.disabled = disabled
      return this
    }
  }

  class MockActionRowBuilder {
    components: MockButtonBuilder[] = []
    addComponents(...items: MockButtonBuilder[]) {
      this.components.push(...items)
      return this
    }
  }

  const builders = {
    ActionRowBuilder: MockActionRowBuilder,
    ButtonBuilder: MockButtonBuilder,
    ButtonStyle: {
      Primary: 1,
      Secondary: 2,
      Success: 3,
      Danger: 4,
      Link: 5,
    },
  }

  it('returns empty array for empty/undefined rows', () => {
    expect(toDiscordComponents(undefined, builders)).toEqual([])
    expect(toDiscordComponents([], builders)).toEqual([])
  })

  it('converts action rows to discord button components with styles and disabled state', () => {
    const components = toDiscordComponents(
      [
        [
          { id: 'btn:1', label: 'Primary', style: 'primary', disabled: true },
          { id: 'btn:2', label: 'Success', style: 'success' },
          { id: 'btn:3', label: 'Danger', style: 'danger' },
          { id: 'btn:4', label: 'Default', style: 'default' },
          { id: 'btn:5', label: 'Link', url: 'https://milo.dev' },
        ],
      ],
      builders,
    ) as MockActionRowBuilder[]

    expect(components).toHaveLength(1)
    const buttons = components[0].components
    expect(buttons).toHaveLength(5)
    expect(buttons[0].data).toEqual({ label: 'Primary', customId: 'btn:1', style: 1, disabled: true })
    expect(buttons[1].data).toEqual({ label: 'Success', customId: 'btn:2', style: 3 })
    expect(buttons[2].data).toEqual({ label: 'Danger', customId: 'btn:3', style: 4 })
    expect(buttons[3].data).toEqual({ label: 'Default', customId: 'btn:4', style: 2 })
    expect(buttons[4].data).toEqual({ label: 'Link', url: 'https://milo.dev', style: 5 })
  })
})
