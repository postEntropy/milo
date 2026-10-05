import { memo, useEffect, useState } from 'react'
import { useCopy, type CopyState } from '../lib/clipboard.js'
import type { ActionRow, FrameAttachment, SessionCardItem, ToolMark, TranscriptMessage } from '@protocol'
import { proseOf } from '@protocol'
import { toolBrand } from '../../../src/gateways/tool-line.ts'
import { todoMark, type TodoItem } from '../../../src/core/todos.ts'
import { toolIconName } from '../ui/tool-icons.js'
import { attachmentUrl } from '../lib/api.js'
import { Markdown } from './Markdown.js'
import { Icon } from '../ui/Icons.js'
import { miloAvatar } from '../ui/milo.js'
import { defaultSuggestions, type Suggestion } from './suggestions.js'

export interface ChatMessage extends TranscriptMessage {
  id: string
  status?: string
  /** What this turn cost the model: tokens in, tokens out. */
  tokens?: { input: number; output: number }
  /** How long the model took before its first output of this turn, in ms. */
  thoughtMs?: number
  /** When the turn's wait for its next output began: what the thought time is
   *  measured from, and that its own line belongs on screen. */
  waitingSince?: number
  /** Already on screen when the session was opened, so it does not settle in again. */
  loaded?: boolean
  actions?: ActionRow[]
  cards?: SessionCardItem[]
}

/**
 * The files delivered into this conversation. A picture shows itself, opening
 * full size when clicked; anything else is a row to download.
 */
function Attachments({ items }: { items: FrameAttachment[] }) {
  return <div className="attachments">{items.map((item) => item.image
    ? <a className="attachment-image" key={item.id} href={attachmentUrl(item.id)}><img src={attachmentUrl(item.id)} alt={item.name} loading="lazy" /></a>
    : <a className="attachment-file" key={item.id} href={attachmentUrl(item.id)} download={item.name}><Icon name="file" size={16} /><span className="attachment-name">{item.name}</span><small className="attachment-size">{formatBytes(item.size)}</small></a>,
  )}</div>
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

function ToolLine({ tool }: { tool: ToolMark }) {
  const { state, copy } = useCopy(tool.text)
  const label = copyLabel(state)
  const brand = toolBrand(tool.name)

  return (
    <div className="tool-line">
      <code>
        <Icon className="tool-mark" name={brand ?? toolIconName(tool.name)} size={14} />{' '}
        {tool.text}
      </code>
      <button
        className={`tool-copy-btn${state === 'failed' ? ' failed' : ''}`}
        type="button"
        title={label}
        aria-label={label}
        onClick={copy}
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={13} />
        {state === 'failed' && <span className="message-tool-label">Copy failed</span>}
      </button>
    </div>
  )
}

/**
 * The plan the model is keeping, drawn whole each time it changes. The current
 * step is the one in the accent colour, the eye's anchor in the list; a finished
 * one is struck through rather than removed, so the progress is legible.
 */
function TodoList({ items }: { items: TodoItem[] }) {
  const seen = new Map<string, number>()
  return (
    <ul className="todo-list">
      {items.map((item) => {
        const of = `${item.status}\u0000${item.content}`
        const occurrence = seen.get(of) ?? 0
        seen.set(of, occurrence + 1)
        return (
          <li key={`${of}-${occurrence}`} className={`todo-item todo-${item.status}`}>
            <span className="todo-mark" aria-hidden="true">{todoMark(item.status)}</span>
            <span className="todo-text">{item.content}</span>
          </li>
        )
      })}
    </ul>
  )
}

function SessionCards({
  cards,
  onSelect,
}: {
  cards: SessionCardItem[]
  onSelect(id: string): void
}) {
  return (
    <div className="session-cards-container">
      {cards.map((card) => {
        const hasDistinctTitle = card.title && card.title !== card.id
        return (
          <button
            key={card.id}
            type="button"
            className="session-card"
            onClick={() => onSelect(card.id)}
          >
            <div className="session-card-head">
              <div className="session-card-title-row">
                <span className="session-card-title">{card.title || card.id}</span>
                {hasDistinctTitle && <span className="session-card-id">{card.id}</span>}
              </div>
              <div className="session-card-meta">
                <span>{card.messageCount} {card.messageCount === 1 ? 'msg' : 'msgs'}</span>
                <span>·</span>
                <span>{card.when}</span>
              </div>
            </div>
            {card.summary && <div className="session-card-body">{card.summary}</div>}
          </button>
        )
      })}
    </div>
  )
}

export function MessageList({
  messages,
  thinking,
  onPrompt,
  onAction,
  onFork,
  onQuote,
  onEdit,
  onRegenerate,
  suggestions,
  busy,
}: {
  messages: ChatMessage[]
  thinking: boolean
  onPrompt?(text: string): void
  onAction?(actionId: string, messageId?: string): void
  onFork?(upToTurn: number): void
  /** The words picked out of a reply, to answer them in particular. */
  onQuote?(text: string): void
  /** Edit one of your messages: send the words again from before it. */
  onEdit?(text: string, upToTurn: number): void
  /** Ask again from the prompt that produced the last answer. */
  onRegenerate?(text: string, upToTurn: number): void
  /** What the welcome screen offers; absent: the standing four. */
  suggestions?: Suggestion[]
  busy?: boolean
}) {
  if (messages.length === 0) return (
    <section className="empty-state" aria-labelledby="welcome-title">
      <img className="empty-brand" src={miloAvatar} alt="" />
      <h1 id="welcome-title">How can I help today?</h1>
      <div className="suggestion-grid">
        {(suggestions ?? defaultSuggestions).map((item) => (
          <button
            className="suggestion"
            key={item.title}
            type="button"
            onClick={() => (item.action ? onAction?.(item.action) : onPrompt?.(item.prompt ?? ''))}
          >
            <Icon name={item.icon} size={19} />
            <span><strong>{item.title}</strong><small>{item.detail}</small></span>
            <Icon className="suggestion-arrow" name="chevron" size={16} />
          </button>
        ))}
      </div>
    </section>
  )

  let currentTurn = 0
  const messageTurns = new Map<string, number>()
  for (const m of messages) {
    if (m.role === 'user') currentTurn++
    messageTurns.set(m.id, currentTurn)
  }

  // What a regenerate would redo: the last answer, with the words that asked for
  // it. Offered only when nothing is running — a turn in flight is not redone.
  let lastAssistant: ChatMessage | undefined
  let lastUser: ChatMessage | undefined
  for (const message of messages) {
    if (message.role === 'assistant' && proseOf(message) && message.waitingSince === undefined) lastAssistant = message
    if (message.role === 'user') lastUser = message
  }
  const regen = !busy && lastAssistant && lastUser
    ? { id: lastAssistant.id, prompt: proseOf(lastUser), upToTurn: (messageTurns.get(lastUser.id) ?? 1) - 1 }
    : undefined

  return <>
    <div className="thread-inner" aria-live="polite" aria-relevant="additions text">
      {messages.filter((m) => hasContent(m, thinking)).map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          thinking={thinking}
          busy={Boolean(busy)}
          turn={messageTurns.get(message.id) ?? 1}
          onAction={onAction}
          onFork={onFork}
          onEdit={onEdit}
          onRegenerate={onRegenerate}
          regenPrompt={message.id === regen?.id ? regen.prompt : undefined}
          regenUpToTurn={message.id === regen?.id ? regen.upToTurn : undefined}
        />
      ))}
    </div>
    {onQuote && <QuoteButton onQuote={onQuote} />}
  </>
}

/**
 * The way to answer one particular stretch of a reply. While words are picked
 * out inside a message, a small "Quote" stands over them; pressing it hands
 * those words to the composer and clears the selection behind it.
 */
function QuoteButton({ onQuote }: { onQuote?(text: string): void }) {
  const [spot, setSpot] = useState<{ text: string; x: number; y: number } | null>(null)

  useEffect(() => {
    const read = (): void => {
      const selection = window.getSelection()
      const text = selection?.toString().trim() ?? ''
      if (!selection || selection.isCollapsed || !text || selection.rangeCount === 0) { setSpot(null); return }
      const range = selection.getRangeAt(selection.rangeCount - 1)
      const node = range.commonAncestorContainer
      const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
      // Only words inside one rendered message: a drag across two of them is a
      // copy, not a quotation aimed at a reply.
      if (!element?.closest('.message-prose')) { setSpot(null); return }
      const rect = range.getBoundingClientRect()
      setSpot({ text, x: rect.left + rect.width / 2, y: rect.top })
    }
    const hide = (): void => setSpot(null)
    document.addEventListener('selectionchange', read)
    document.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('selectionchange', read)
      document.removeEventListener('scroll', hide, true)
    }
  }, [])

  if (!spot) return null
  return <button
    className="quote-button"
    type="button"
    style={{ left: spot.x, top: spot.y }}
    onMouseDown={(event) => event.preventDefault()}
    onClick={() => {
      onQuote?.(spot.text)
      window.getSelection()?.removeAllRanges()
      setSpot(null)
    }}
  >
    <Icon name="quote" size={13} /> Quote
  </button>
}

/**
 * One message. Memoized by the message object, which keeps its identity until a
 * token actually lands in it — so a streaming answer grows only its own row and
 * leaves every earlier one untouched, instead of reconciling the whole thread on
 * each frame.
 */
const MessageRow = memo(function MessageRow({ message, thinking, busy, turn, onAction, onFork, onEdit, onRegenerate, regenPrompt, regenUpToTurn }: {
  message: ChatMessage
  thinking: boolean
  busy: boolean
  turn: number
  onAction?(actionId: string, messageId?: string): void
  onFork?(upToTurn: number): void
  onEdit?(text: string, upToTurn: number): void
  onRegenerate?(text: string, upToTurn: number): void
  regenPrompt?: string
  regenUpToTurn?: number
}) {
  const [revealed, setRevealed] = useState(false)
  const parts = message.parts
  const hasReasoning = parts.some((part) => part.kind === 'reasoning')
  const showReasoning = thinking || revealed
  const firstReasoning = parts.findIndex((part) => part.kind === 'reasoning')
  // A part's place is its identity: parts only ever append, so a running count
  // per kind names each one for as long as the turn streams.
  const seen = new Map<string, number>()
  const keyed = parts.map((part) => {
    const occurrence = seen.get(part.kind) ?? 0
    seen.set(part.kind, occurrence + 1)
    return { part, key: `${part.kind}-${occurrence}` }
  })
  const prose = proseOf(message)
  return <article className={`message ${message.role}${message.loaded ? ' is-loaded' : ''}`}>
    <div className="message-content">
      {hasReasoning && !showReasoning && (message.thoughtMs ?? 0) >= 1000 && (
        <button className="reasoning-note reasoning-reveal" type="button" title="Show thinking" onClick={() => setRevealed(true)}>
          <Icon name="spark" size={14} /> {thoughtLabel(message.thoughtMs)}
          <span className="reasoning-reveal-hint">Show thinking</span>
        </button>
      )}
      {!hasReasoning && message.thoughtMs !== undefined && message.thoughtMs >= 1000 && (
        <div className="reasoning-note"><Icon name="spark" size={14} /> {thoughtLabel(message.thoughtMs)}</div>
      )}
      {message.cards && message.cards.length > 0 ? (
        <SessionCards
          cards={message.cards}
          onSelect={(id) => onAction?.(`resume:${id}`, message.id)}
        />
      ) : (
        keyed.map(({ part, key }, index) => {
          if (part.kind === 'reasoning') {
            return showReasoning
              ? <Reasoning key={key} text={part.text} thoughtMs={index === firstReasoning ? message.thoughtMs : undefined} animateIn={!thinking} />
              : null
          }
          if (part.kind === 'text') return <Markdown key={key} text={part.text} />
          if (part.kind === 'tool') return <ToolLine key={key} tool={part.tool} />
          return <TodoList key={key} items={part.items} />
        })
      )}
      {message.attachments && message.attachments.length > 0 && <Attachments items={message.attachments} />}
      {message.actions && message.actions.length > 0 && (
        <div className="message-actions">
          {message.actions.map((row) => (
            <div className="action-row" key={row.map((b) => b.id).join('-')}>
              {row.map((btn) => {
                const isIndicator = Boolean(btn.disabled)
                if (isIndicator) {
                  return (
                    <span key={btn.id} className="action-indicator">
                      {btn.label}
                    </span>
                  )
                }
                if (btn.url) {
                  return (
                    <a
                      key={btn.id}
                      className={`action-btn ${btn.style ? `action-${btn.style}` : ''}`}
                      href={btn.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {btn.label}
                    </a>
                  )
                }
                return (
                  <button
                    key={btn.id}
                    type="button"
                    className={`action-btn ${btn.style ? `action-${btn.style}` : ''}`}
                    onClick={() => onAction?.(btn.id, message.id)}
                  >
                    {btn.label}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
      {message.role === 'assistant' && prose && message.waitingSince === undefined && (
        <div className="message-toolbar">
          <CopyButton text={prose} />
          {onFork && (
            <button
              className="message-tool-btn"
              type="button"
              disabled={busy}
              title="Fork session from here"
              aria-label="Fork session from here"
              onClick={() => onFork(turn)}
            >
              <Icon name="branch" size={15} />
              <span className="message-tool-label">Fork</span>
            </button>
          )}
          {onRegenerate && regenPrompt !== undefined && (
            <button
              className="message-tool-btn"
              type="button"
              disabled={busy}
              title="Ask this again"
              aria-label="Regenerate this answer"
              onClick={() => onRegenerate(regenPrompt, regenUpToTurn ?? 0)}
            >
              <Icon name="repeat" size={15} />
              <span className="message-tool-label">Regenerate</span>
            </button>
          )}
        </div>
      )}
      {message.waitingSince !== undefined && <WaitLine />}
      {message.status && <div className="message-status">{message.status}</div>}
    </div>
    {/* The person's own message is a filled bubble: its controls sit under it, not
        inside it, the way the model's sit under its answer. */}
    {message.role === 'user' && prose && onEdit && <div className="message-below">
      <div className="message-toolbar">
        <button className="message-tool-btn" type="button" title="Edit this message" aria-label="Edit this message" onClick={() => onEdit(prose, turn - 1)}>
          <Icon name="edit" size={15} />
          <span className="message-tool-label">Edit</span>
        </button>
      </div>
    </div>}
  </article>
})

/**
 * The wait for the model's next output: a glyph, the word and three dots, so a
 * turn that has nothing to show yet still says it is running. Whatever arrives
 * next takes this line's place.
 */
function WaitLine() {
  return <div className="wait-line">
    <Icon name="spark" size={14} />
    <span>thinking</span>
    {/* Motion rather than something to read: out of the accessibility tree. */}
    <span className="wait-dots" aria-hidden="true"><span className="wait-dot" /><span className="wait-dot" /><span className="wait-dot" /></span>
  </div>
}

/**
 * What the model thought, and how long it took. Open by default: the wait is
 * the thing a person asks about, and a collapsed block answers it with nothing.
 */
function Reasoning({ text, thoughtMs, animateIn = false }: { text: string; thoughtMs?: number; animateIn?: boolean }) {
  const [open, setOpen] = useState(!animateIn)
  useEffect(() => {
    if (!animateIn) return
    // Opened a frame after it appears, so the transition has a shut state to
    // travel from instead of the block simply being there already open.
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [animateIn])
  return <div className={`reasoning ${open ? 'open' : ''}`}>
    <button className="reasoning-summary" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Icon name="spark" size={15} /> {thoughtLabel(thoughtMs)} <Icon className="reasoning-chevron" name="chevron" size={14} />
    </button>
    <div className="reasoning-collapse"><div className="reasoning-body">{text}</div></div>
  </div>
}

/** The terminal's wording, so both surfaces say the same thing about a wait. */
function thoughtLabel(ms?: number): string {
  return ms !== undefined && ms >= 1000 ? `Thought for ${formatSeconds(ms / 1000)}` : 'Reasoning'
}

/** A tenth of a second matters at 6.4s; at 51s it is noise. */
function formatSeconds(value: number): string {
  return `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}s`
}

function CopyButton({ text }: { text: string }) {
  const { state, copy } = useCopy(text)

  return (
    <button
      className={`message-tool-btn${state === 'failed' ? ' failed' : ''}`}
      type="button"
      title={copyLabel(state)}
      aria-label={copyLabel(state)}
      onClick={copy}
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={15} />
      <span className="message-tool-label">{state === 'failed' ? 'Copy failed' : state === 'copied' ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

/** What the copy control says, including when it could not copy at all. */
function copyLabel(state: CopyState): string {
  if (state === 'copied') return 'Copied'
  if (state === 'failed') return 'Copy failed — select the text and copy it by hand'
  return 'Copy'
}

function hasContent(message: ChatMessage, thinking: boolean): boolean {
  if (message.parts.some((part) => part.kind === 'text' && part.text.trim())) return true
  if (message.parts.some((part) => part.kind === 'tool' || part.kind === 'todo')) return true
  if (thinking && message.parts.some((part) => part.kind === 'reasoning')) return true
  if (message.attachments && message.attachments.length > 0) return true
  if (message.cards && message.cards.length > 0) return true
  if (message.actions && message.actions.length > 0) return true
  if (message.waitingSince !== undefined) return true
  if (message.status) return true
  return false
}
