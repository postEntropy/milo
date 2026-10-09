import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCopy, type CopyState } from '../lib/clipboard.js'
import { formatTokens } from '../lib/format.js'
import { formatWhen } from '../../../src/core/sessions/format.ts'
import type { ActionRow, FrameAttachment, SessionCardItem, ToolMark, TranscriptMessage } from '@protocol'
import { proseOf } from '@protocol'
import { toolBrand } from '../../../src/gateways/tool-line.ts'
import type { TodoItem, TodoStatus } from '../../../src/core/todos.ts'
import { toolIconName } from '../ui/tool-icons.js'
import { attachmentUrl } from '../lib/api.js'
import { Markdown } from './Markdown.js'
import { Icon, type IconName } from '../ui/Icons.js'
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
  /** The tool call running right now, so the wait is shown while it executes. */
  runningTool?: string
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

/** A shape per state, so the step is told apart without leaning on colour. */
const TODO_MARK: Record<TodoStatus, IconName> = {
  pending: 'circle',
  in_progress: 'circle-dot',
  completed: 'check',
}

/** The same three states in words, for whoever cannot see the mark. */
const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
}

/**
 * The plan the model is keeping, drawn whole each time it changes: a card that
 * names itself and how far it has got, the current step in the accent so the
 * eye lands on it, a finished one struck through rather than removed.
 */
function TodoList({ items }: { items: TodoItem[] }) {
  const seen = new Map<string, number>()
  const done = items.filter((item) => item.status === 'completed').length
  return (
    <div className="todo-card">
      <div className="todo-head">
        <Icon name="list-check" size={14} />
        <span>Plan</span>
        <span className="todo-count"><strong className="todo-count-done">{done}</strong>/{items.length}</span>
      </div>
      <ul className="todo-list">
        {items.map((item) => {
          const of = `${item.status}\u0000${item.content}`
          const occurrence = seen.get(of) ?? 0
          seen.set(of, occurrence + 1)
          return (
            <li key={`${of}-${occurrence}`} className={`todo-item todo-${item.status}`}>
              <Icon className="todo-mark" name={TODO_MARK[item.status]} size={14} />
              <span className="sr-only">{TODO_STATUS_LABEL[item.status]}</span>
              <span className="todo-text">{item.content}</span>
            </li>
          )
        })}
      </ul>
    </div>
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
          onQuote={onQuote}
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
const MessageRow = memo(function MessageRow({ message, thinking, busy, turn, onAction, onFork, onEdit, onRegenerate, onQuote, regenPrompt, regenUpToTurn }: {
  message: ChatMessage
  thinking: boolean
  busy: boolean
  turn: number
  onAction?(actionId: string, messageId?: string): void
  onFork?(upToTurn: number): void
  onEdit?(text: string, upToTurn: number): void
  onRegenerate?(text: string, upToTurn: number): void
  onQuote?(text: string): void
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
          <MessageMenu at={message.at} tokens={message.tokens} thoughtMs={message.thoughtMs} prose={prose} onQuote={onQuote} />
        </div>
      )}
      {message.waitingSince !== undefined && <WaitLine />}
      {message.runningTool !== undefined && <WaitLine label={`${message.runningTool}…`} />}
      {message.status && <div className="message-status">{message.status}</div>}
    </div>
    {/* The person's own message is a filled bubble: its controls sit under it, not
        inside it, the way the model's sit under its answer. */}
    {message.role === 'user' && prose && (onEdit || onQuote) && <div className="message-below">
      <div className="message-toolbar">
        {onEdit && <button className="message-tool-btn" type="button" title="Edit this message" aria-label="Edit this message" onClick={() => onEdit(prose, turn - 1)}>
          <Icon name="edit" size={15} />
          <span className="message-tool-label">Edit</span>
        </button>}
        <MessageMenu at={message.at} prose={prose} onQuote={onQuote} />
      </div>
    </div>}
  </article>
})

/**
 * The wait for the model's next output: a steady glyph and the word, with a light
 * travelling along the word, so a turn that has nothing to show yet still says it
 * is running. Whatever arrives next takes this line's place. The same line stands
 * for a tool call while it executes, named so the wait is attributed to what is
 * actually running.
 */
function WaitLine({ label = 'Thinking' }: { label?: string }) {
  return <div className="wait-line">
    <Icon name="spark" size={14} />
    <span className="wait-label">{label}</span>
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
    <div className="reasoning-collapse"><div className="reasoning-clip"><div className="reasoning-body">{text}</div></div></div>
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

/**
 * What a message is and what can be done with it, behind the three dots: when it
 * was said, what an answer cost (tokens and thinking time, when the turn that
 * produced it is still the one on screen), and the way to answer it as a whole.
 *
 * The panel is placed against the window rather than the thread: opened near an
 * edge it flips and slides to stay whole instead of spilling off the screen, and
 * a scroll moves it with its button rather than leaving it behind or cutting it
 * at the scroller's edge.
 */
function MessageMenu({ at, tokens, thoughtMs, prose, onQuote }: {
  at?: number
  tokens?: { input: number; output: number }
  thoughtMs?: number
  prose: string
  onQuote?(text: string): void
}) {
  const [open, setOpen] = useState(false)
  const [spot, setSpot] = useState<{ left: number; top: number; up: boolean } | null>(null)
  // Armed one frame after the panel mounts: an element that gets its entrance
  // animation in the very style pass it first appears in does not always travel,
  // so the growth is held a frame and then let go.
  const [shown, setShown] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) { setShown(false); return }
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [open])

  useLayoutEffect(() => {
    if (!open) { setSpot(null); return }
    const place = (): void => {
      const from = anchor.current?.getBoundingClientRect()
      const size = panel.current?.getBoundingClientRect()
      if (!from || !size) return
      const margin = 10
      const gap = 8
      // Below when it fits, above otherwise: a menu that is always on screen, and
      // that covers as little of the message it belongs to as the room allows.
      const up = from.bottom + gap + size.height > window.innerHeight - margin
      const top = up ? from.top - gap - size.height : from.bottom + gap
      const widest = Math.max(margin, window.innerWidth - size.width - margin)
      setSpot({ up, left: Math.min(Math.max(margin, from.left), widest), top: Math.max(margin, top) })
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open])

  const thinking = thoughtMs !== undefined && thoughtMs >= 1000
  const hasInfo = at !== undefined || tokens !== undefined || thinking

  return <span className="message-more" ref={box}>
    <button
      ref={anchor}
      className={`message-tool-btn${open ? ' open' : ''}`}
      type="button"
      title="Message actions"
      aria-label="Message actions"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <Icon name="dots" size={15} />
    </button>
    {open && <div
      ref={panel}
      className={`message-menu${shown ? ' in' : ''}${spot?.up ? ' up' : ''}`}
      role="menu"
      aria-label="Message actions"
      style={spot ? { left: spot.left, top: spot.top } : undefined}
    >
      {at !== undefined && <div className="message-menu-row" role="presentation">
        <Icon name="clock" size={14} />
        <span>{formatWhen(at)}</span>
      </div>}
      {tokens && <div className="message-menu-row" role="presentation">
        <Icon name="cpu" size={14} />
        <span>{formatTokens(tokens.input)} in · {formatTokens(tokens.output)} out</span>
      </div>}
      {thinking && <div className="message-menu-row" role="presentation">
        <Icon name="spark" size={14} />
        <span>{thoughtLabel(thoughtMs)}</span>
      </div>}
      {hasInfo && onQuote && <div className="message-menu-sep" />}
      {onQuote && <button
        className="message-menu-action"
        type="button"
        role="menuitem"
        onClick={() => {
          setOpen(false)
          onQuote(prose)
        }}
      >
        <Icon name="quote" size={15} />
        <span>Quote this message</span>
      </button>}
    </div>}
  </span>
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
