import type { FileChange } from '../../core/change.js'
import { DEFAULT_DISPLAY, type DisplayConfig } from '../../core/config/schema.js'
import { genUiFromArgs, type GenUiNode, type GenUiRender } from '../../core/genui.js'
import { GenUiFence } from '../../core/genui-fence.js'
import type { PanelRequest } from '../../core/panel.js'
import type { ContentPart, Message } from '../../core/providers/types.js'
import { formatSeconds } from '../../core/sessions/format.js'
import { todosFromArgs } from '../../core/todos.js'
import {
  changeCounts,
  drawsToolFailure,
  toolDetail,
  toolDraw,
  toolParts,
  toolResult,
} from '../tool-line.js'
import type { Item } from './transcript.js'

interface ToolOutcome {
  failed: boolean
  result: string
  change?: FileChange[]
}

/**
 * Hydrates stored `Session.messages` into TUI `Item[]`, honouring the same
 * `display.tools` and `display.thinking` rules the live stream uses.
 */
export function itemsFromMessages(messages: Message[], display: DisplayConfig = DEFAULT_DISPLAY): Item[] {
  const items: Item[] = []
  const outcomes = collectOutcomes(messages)
  let lastBotId: string | undefined

  for (const message of messages) {
    if (message.internal) continue

    if (message.role === 'user') {
      lastBotId = undefined
      pushUserMessage(message, items)
      continue
    }

    if (message.role === 'assistant' && message.routine) {
      lastBotId = undefined
      pushRoutineMessage(message, items)
      continue
    }

    if (message.role === 'assistant') {
      const botId = message.bot?.id
      const includeBotHeader = Boolean(message.bot && botId !== lastBotId)
      lastBotId = botId
      pushAssistantMessage(message, outcomes, display, items, includeBotHeader)
    }
  }

  return items
}

function collectOutcomes(messages: Message[]): Map<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue
      outcomes.set(part.id, {
        failed: part.isError === true,
        result: part.content,
        ...(part.change && part.change.length > 0 ? { change: part.change } : {}),
      })
    }
  }
  return outcomes
}

function attachmentNote(part: ContentPart): string | null {
  if (part.type === 'image' && !part.derivedFromDocument) return `[image: ${part.name}]`
  if (part.type === 'document' || part.type === 'audio' || part.type === 'file') return `[file: ${part.name}]`
  return null
}

function pushUserMessage(message: Message, items: Item[]): void {
  const rawText = message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
  const shown = (message.displayText ?? rawText).trim()
  const attachments = message.content.map(attachmentNote).filter((note): note is string => note !== null)
  const combined = [shown, attachments.join(' ')].filter(Boolean).join('\n')
  if (combined) items.push({ kind: 'user', text: combined })

  if (message.mediaNotices?.length) {
    for (const notice of message.mediaNotices) {
      items.push({ kind: 'info', text: `⚠ ${notice}` })
    }
  }
}

function pushRoutineMessage(message: Message, items: Item[]): void {
  const routine = message.routine!
  items.push({
    kind: 'info',
    text: routine.failed ? `⚠ Routine "${routine.name}" failed` : `⏱ Routine: ${routine.name}`,
  })
  for (const part of message.content) {
    if (part.type === 'text' && part.text.trim()) {
      pushTextParts(part.text, items)
    } else if (part.type === 'file') {
      items.push({ kind: 'info', text: `[file: ${part.name}]` })
    }
  }
}

function pushAssistantMessage(
  message: Message,
  outcomes: Map<string, ToolOutcome>,
  display: DisplayConfig,
  items: Item[],
  includeBotHeader = Boolean(message.bot),
): void {
  if (includeBotHeader && message.bot) {
    items.push({ kind: 'bot', bot: message.bot })
  }
  const thoughtHeader =
    message.thoughtMs !== undefined && message.thoughtMs >= 1000
      ? `✻ Thought for ${formatSeconds(message.thoughtMs / 1000)}`
      : ''
  const hasReasoning = message.content.some((part) => part.type === 'reasoning' && part.text.trim() !== '')
  let emittedHeader = false

  if (!hasReasoning && thoughtHeader) {
    items.push({ kind: 'reasoning', header: thoughtHeader, text: '' })
    emittedHeader = true
  }

  for (const part of message.content) {
    if (part.type === 'reasoning') {
      if (!part.text.trim()) continue
      const header = !emittedHeader ? thoughtHeader : ''
      emittedHeader = true
      if (display.thinking === 'collapsed') {
        if (header) items.push({ kind: 'reasoning', header, text: '' })
      } else {
        items.push({ kind: 'reasoning', header, text: part.text })
      }
      continue
    }

    if (part.type === 'text') {
      if (part.text) pushTextParts(part.text, items)
      continue
    }

    if (part.type === 'tool-call') {
      if (part.name === 'render_ui') {
        const render = genUiFromArgs(part.args)
        if (render) {
          items.push({
            kind: 'ui',
            ...(render.title ? { title: render.title } : {}),
            summary: summarizeGenUi(render),
          })
        }
      }

      const todos = todosFromArgs(part.args)
      if (todos.length > 0) items.push({ kind: 'todo', items: todos })

      if (part.name === 'panel') {
        const detail = describePanelCall(part.args)
        if (detail) items.push({ kind: 'panel', detail })
      }

      const outcome = outcomes.get(part.id)
      const mark = toolDraw(part.name, part.args, display.tools)
      if (mark) {
        const { value: detail } = toolParts(part.name, mark.text)
        const counts = display.tools === 'full' ? changeCounts(outcome?.change) : ''
        const result = display.tools === 'full' && outcome ? toolResult(outcome.result) : ''
        const change = display.tools === 'full' ? outcome?.change : undefined
        items.push({
          kind: 'tool',
          name: part.name,
          detail,
          ok: outcome ? !outcome.failed : true,
          ...(counts ? { counts } : {}),
          ...(display.tools === 'full' && part.args !== undefined ? { args: part.args } : {}),
          ...(result ? { result } : {}),
          ...(change ? { change } : {}),
        })
      } else if (drawsToolFailure(part.name) && outcome?.failed === true) {
        const detail = display.tools === 'name' ? '' : toolDetail(part.args)
        const result = display.tools === 'full' ? toolResult(outcome.result) : ''
        const change = display.tools === 'full' ? outcome.change : undefined
        items.push({
          kind: 'tool',
          name: part.name,
          detail,
          ok: false,
          ...(display.tools === 'full' && part.args !== undefined ? { args: part.args } : {}),
          ...(result ? { result } : {}),
          ...(change ? { change } : {}),
        })
      }
      continue
    }

    if (part.type === 'file') {
      items.push({ kind: 'info', text: `[file: ${part.name}]` })
    }
  }

  if (message.verification) {
    items.push({ kind: 'verification', ok: message.verification.ok, text: message.verification.text })
  }
  if (message.error) {
    items.push({ kind: 'error', text: message.error })
  }
}

function pushTextParts(text: string, items: Item[]): void {
  const fence = new GenUiFence()
  for (const part of [...fence.push(text), ...fence.finish()]) {
    if (part.kind === 'ui') {
      items.push({
        kind: 'ui',
        ...(part.render.title ? { title: part.render.title } : {}),
        summary: summarizeGenUi(part.render),
      })
    } else if ((part.kind === 'text' || part.kind === 'refused') && part.text.trim()) {
      items.push({ kind: 'assistant', text: part.text })
    }
  }
}

function describePanelCall(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const record = args as Record<string, unknown>
  return describePanelRequest({
    close: record.action === 'close',
    browser: record.browser === true,
    path: typeof record.path === 'string' ? record.path : undefined,
    title: typeof record.title === 'string' ? record.title : undefined,
  })
}

export function describePanelRequest(request: PanelRequest): string | null {
  const title = request.title?.trim() ?? ''
  if (request.close) return title ? `Closed panel: ${title}` : 'Closed panel'
  if (request.browser) return title ? `Opened browser panel: ${title}` : 'Opened browser panel'
  const file = request.path?.trim()
  if (file) {
    return title ? `Opened panel: ${title} (${file})` : `Opened panel: ${file}`
  }
  return null
}

export function summarizeGenUi(render: GenUiRender): string {
  const inner = summarizeNode(render.tree)
  return inner || render.title || 'Interactive widget'
}

function summarizeNode(node: GenUiNode): string {
  switch (node.kind) {
    case 'title':
    case 'text':
      return node.text
    case 'callout':
      return node.title ? `${node.title}: ${node.text}` : node.text
    case 'badge':
      return node.label
    case 'table':
      return `${node.columns.join(', ')} (${node.rows.length} row${node.rows.length === 1 ? '' : 's'})`
    case 'list':
      return node.items.slice(0, 3).join(' · ')
    case 'facts':
      return node.entries
        .slice(0, 4)
        .map((entry) => `${entry.label}: ${entry.value}`)
        .join(' · ')
    case 'steps':
      return node.entries.map((entry) => entry.title).join(' -> ')
    case 'timeline':
      return node.entries.map((entry) => `${entry.when}: ${entry.title}`).join(' · ')
    case 'chart':
      return `${node.type} chart (${node.labels.join(', ')})`
    case 'stat':
      return `${node.label}: ${node.formula}`
    case 'progress':
      return node.label ?? `progress (${node.formula})`
    case 'section':
      return node.title
    case 'box':
    case 'form':
      return node.children
        .map(summarizeNode)
        .filter(Boolean)
        .slice(0, 3)
        .join(' · ')
    case 'tabs':
      return node.tabs.map((tab) => tab.label).join(' | ')
    case 'accordion':
      return node.items.map((item) => item.title).join(' · ')
    default:
      return 'label' in node && typeof node.label === 'string' ? node.label : `[${node.kind}]`
  }
}
