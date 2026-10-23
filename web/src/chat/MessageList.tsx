import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useCopy, type CopyState } from '../lib/clipboard.js'
import { formatSeconds } from '../../../src/core/sessions/format.ts'
import { formatWhen } from '../../../src/core/time.js'
import { formatTokens, humanSize } from '../../../src/util/format.ts'
import type { ActionRow, FrameAttachment, SessionCardItem, ThinkingDisplay, ToolMark, TranscriptMessage, TranscriptPart } from '@protocol'
import { proseOf } from '@protocol'
import { toolBrand, toolLabel, toolResultPreview, changeTotals } from '../../../src/gateways/tool-line.ts'
import type { FileChange } from '../../../src/core/change.ts'
import { toolRows } from './tool-runs.js'
import type { TodoItem, TodoStatus } from '../../../src/core/todos.ts'
import { toolIconName } from '../ui/tool-icons.js'
import { attachmentUrl } from '../lib/api.js'
import { Markdown } from './Markdown.js'
import { GenUi } from './genui/GenUi.js'
import { Icon, type IconName } from '../ui/Icons.js'
import { ImageViewer } from '../ui/ImageViewer.js'
import { WaitLine } from '../ui/WaitLine.js'
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
 *
 * The picture opens over the app, not at its own address: a link would take the
 * person out of the conversation and into the browser's own picture, with no way
 * back to the thread but the browser's own history.
 */
function Attachments({ items }: { items: FrameAttachment[] }) {
  const [open, setOpen] = useState<FrameAttachment | null>(null)
  const close = useCallback((): void => setOpen(null), [])
  return <>
    <div className="attachments">{items.map((item) => item.image
      ? <button className="attachment-image" key={item.id} type="button" title={`Open ${item.name}`} onClick={() => setOpen(item)}><img src={attachmentUrl(item.id)} alt={item.name} loading="lazy" /></button>
      : <a className="attachment-file" key={item.id} href={attachmentUrl(item.id)} download={item.name}><Icon name="file" size={16} /><span className="attachment-name">{item.name}</span><small className="attachment-size">{humanSize(item.size)}</small></a>,
    )}</div>
    {open && <ImageViewer src={attachmentUrl(open.id)} name={open.name} onClose={close} />}
  </>
}

/**
 * One call, as a line: the mark, the tool's name, and the one value worth showing.
 *
 * No box. A call is the turn's own activity, not an object sitting in it, and the
 * box it used to be drawn in gave every call the same weight as a paragraph of the
 * answer. The name carries the colour and the value stays quiet, so the eye can
 * find a call by what it was — which is what tells one from another. The dot in the
 * gutter beside it is the call's state, drawn for every call alike, so a lone call
 * is not pushed aside into an empty column.
 */
function ToolLine({ tool }: { tool: ToolMark }) {
  const { state: copied, copy } = useCopy(tool.text)
  const label = copyLabel(copied)
  const brand = toolBrand(tool.name)
  // The text is the name and its value in one string. Splitting on the name is what
  // lets the name be loud and the value quiet — and where a line does not begin with
  // its own name (an MCP tool's display name, most often) the whole of it is the name,
  // which is the honest reading rather than a guess at where the value starts.
  const name = toolLabel(tool.name, false)
  const value = tool.text.startsWith(name) ? tool.text.slice(name.length).trim() : ''
  const totals = changeTotals(tool.change)

  return (
    <div className="tool-call">
      <div className={`tool-line${tool.state ? ` ${tool.state}` : ''}`}>
        <code>
          <Icon className="tool-mark" name={brand ?? toolIconName(tool.name)} size={14} />{' '}
          <span className="tool-name">{value ? name : tool.text}</span>
          {value && <span className="tool-value">{value}</span>}
          {/* How much moved, in the same two tones the Work screen counts a folder's
              changes with: the number is the call's footprint, and it is read before the
              result is opened. */}
          {(totals.additions > 0 || totals.deletions > 0) && (
            <span className="tool-change-count">
              {totals.additions > 0 && <span className="plus">+{totals.additions}</span>}
              {totals.deletions > 0 && <span className="minus">−{totals.deletions}</span>}
            </span>
          )}
          {tool.state === 'failed' && <span className="tool-failed">failed</span>}
        </code>
        <button
          className={`tool-copy-btn${copied === 'failed' ? ' failed' : ''}`}
          type="button"
          title={label}
          aria-label={label}
          onClick={copy}
        >
          <Icon name={copied === 'copied' ? 'check' : 'copy'} size={13} />
          {copied === 'failed' && <span className="message-tool-label">Copy failed</span>}
        </button>
      </div>
      {/* A call that wrote shows what it wrote, in the lines themselves; the tool's
          own sentence about it is the preview that stays in Copy raw. */}
      {tool.change && tool.change.length > 0 ? (
        <ToolChange files={tool.change} />
      ) : (
        tool.result && <ToolResult text={tool.result} />
      )}
    </div>
  )
}

/**
 * The lines a call changed, folded under it the way its result is. What a call wrote is
 * the thing the person came to check — the numbers on the line say how much, and this is
 * which lines. Green and red are the diff's own marking, the one place colour is data.
 */
function ToolChange({ files }: { files: FileChange[] }) {
  const [open, setOpen] = useState(false)
  const count = files.length === 1 ? '1 file changed' : `${files.length} files changed`
  return (
    <div className={`tool-result tool-change${open ? ' open' : ''}`}>
      <button
        className="tool-result-head"
        type="button"
        aria-expanded={open}
        title={open ? 'Hide the change' : 'Show the change'}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chevron" size={12} />
        <span className="tool-result-preview">{count}</span>
      </button>
      {open && <div className="tool-change-body">
        {files.map((file) => <div className="tool-change-file" key={file.path}>
          {files.length > 1 && <div className="tool-change-path" title={file.path}>
            {file.path}{file.created ? ' (new)' : file.deleted ? ' (deleted)' : ''}
          </div>}
          <div className="tool-change-lines">
            {file.lines.map((line) => <div
              className={`tool-change-line ${line.kind}`}
              key={`${line.kind}:${line.old ?? ''}:${line.new ?? ''}`}
            >
              <span className="tool-change-num">{line.old ?? ''}</span>
              <span className="tool-change-num">{line.new ?? ''}</span>
              <span className="tool-change-mark">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
              <span className="tool-change-text">{line.text === '' ? ' ' : line.text}</span>
            </div>)}
            {file.truncated && <div className="tool-change-more">…</div>}
          </div>
        </div>)}
      </div>}
    </div>
  )
}

/**
 * What the call came back with, under its own line. Folded to the first line: the answer
 * is the turn's words, and a result spread whole through the thread pushes them apart.
 * Opening it draws all of what the server sent — already capped there, so the whole record
 * lives in Copy raw and this is a reading of it.
 */
function ToolResult({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const first = toolResultPreview(text)
  return (
    <div className={`tool-result${open ? ' open' : ''}`}>
      <button
        className="tool-result-head"
        type="button"
        aria-expanded={open}
        title={open ? 'Hide result' : 'Show result'}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="chevron" size={12} />
        <span className="tool-result-preview">{first}</span>
      </button>
      {open && <pre className="tool-result-body">{text}</pre>}
    </div>
  )
}

/**
 * Calls that came one after another, drawn as one sequence: a thread with a dot
 * per step. The dot is the state — accent on the call running now, filled and
 * quiet on the ones that finished, red on one that failed — so which step is
 * underway is read off the line rather than said again underneath it.
 */
function ToolRun({ steps }: { steps: Array<{ tool: ToolMark; key: string }> }) {
  return <div className="tool-run">
    {steps.map((step) => <ToolLine key={step.key} tool={step.tool} />)}
  </div>
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
 * The project's checks, after a turn that wrote. One filled block, no border:
 * the verdict is the first line's colour, and the failing command's own output
 * sits under it in the same block.
 */
function Verification({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className={`verification-card ${ok ? 'ok' : 'failed'}`}>
      <pre className="verification-text">{text}</pre>
    </div>
  )
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
  hasIdeas,
  busy,
}: {
  messages: ChatMessage[]
  thinking: ThinkingDisplay
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
  /** Whether the model's ideas have replaced the standing four on the home. */
  hasIdeas?: boolean
  busy?: boolean
}) {
  if (messages.length === 0) return (
    <section className="empty-state" aria-labelledby="welcome-title">
      <h1 id="welcome-title">How can I help today?</h1>
      {/* Remounted when the ideas take over from the standing four, so the chips
          fade in rather than the set jumping in place. */}
      <div className="suggestion-grid" key={hasIdeas ? 'ideas' : 'standing'}>
        {(suggestions ?? defaultSuggestions).map((item) => (
          <button
            className="suggestion"
            key={item.title}
            type="button"
            title={item.detail}
            onClick={() => (item.action ? onAction?.(item.action) : onPrompt?.(item.prompt ?? ''))}
          >
            <Icon name={item.icon} size={16} />
            <span>{item.title}</span>
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

  // The turn in flight is the last thing said, so while one runs its own row is the one
  // that has not finished: the controls that act on a finished answer — copy, fork,
  // regenerate — wait for it instead of standing under words still being written.
  let runningId: string | undefined
  if (busy) for (const message of messages) if (message.role === 'assistant') runningId = message.id

  return <>
    <div className={`thread-inner${messages[0]?.loaded ? ' is-opened' : ''}`} aria-live="polite" aria-relevant="additions text">
      {messages.filter((m) => hasContent(m)).map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          thinking={thinking}
          busy={Boolean(busy)}
          running={message.id === runningId}
          turn={messageTurns.get(message.id) ?? 1}
          onAction={onAction}
          onFork={onFork}
          onEdit={onEdit}
          onRegenerate={onRegenerate}
          onQuote={onQuote}
          onSend={onPrompt}
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
const MessageRow = memo(function MessageRow({ message, thinking, busy, running, turn, onAction, onFork, onEdit, onRegenerate, onQuote, onSend, regenPrompt, regenUpToTurn }: {
  message: ChatMessage
  thinking: ThinkingDisplay
  busy: boolean
  /** The message this turn is still writing; its answer is not ready to act on. */
  running: boolean
  turn: number
  onAction?(actionId: string, messageId?: string): void
  onFork?(upToTurn: number): void
  onEdit?(text: string, upToTurn: number): void
  onRegenerate?(text: string, upToTurn: number): void
  onQuote?(text: string): void
  /** What a generated interface's button sends, as a new turn. */
  onSend?(text: string): void
  regenPrompt?: string
  regenUpToTurn?: number
}) {
  const parts = message.parts
  // A part's place is its identity: parts only ever append, so a running count
  // per kind names each one for as long as the turn streams.
  const seen = new Map<string, number>()
  const keyed = parts.map((part) => {
    const occurrence = seen.get(part.kind) ?? 0
    seen.set(part.kind, occurrence + 1)
    return { part, key: `${part.kind}-${occurrence}` }
  })
  // Named by position rather than by counting again once the calls are grouped: the
  // settle-in time belongs to the turn's first thought, wherever the thread lands.
  const firstReasoning = keyed.find(({ part }) => part.kind === 'reasoning')?.key
  const prose = proseOf(message)
  return <article className={`message ${message.role}${message.loaded ? ' is-loaded' : ''}`}>
    <div className="message-content">
      {message.cards && message.cards.length > 0 ? (
        <SessionCards
          cards={message.cards}
          onSelect={(id) => onAction?.(`resume:${id}`, message.id)}
        />
      ) : (
        toolRows(keyed).map((row) => {
          if (row.kind === 'spine') return <ToolRun key={row.key} steps={row.steps} />
          const { part, key } = row
          if (part.kind === 'reasoning') {
            // Every thought is on screen; the display only decides whether it
            // arrives open or folded, both one press from the other.
            return <Reasoning key={key} text={part.text} thoughtMs={key === firstReasoning ? message.thoughtMs : undefined} open={thinking === 'expanded'} />
          }
          if (part.kind === 'text') return <Markdown key={key} text={part.text} />
          if (part.kind === 'tool') return <ToolLine key={key} tool={part.tool} />
          if (part.kind === 'ui') return <GenUi key={key} render={part.render} onSend={onSend} />
          if (part.kind === 'verification') return <Verification key={key} ok={part.ok} text={part.text} />
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
      {message.role === 'assistant' && prose && message.waitingSince === undefined && !running && (
        <div className="message-toolbar">
          <CopyButton text={prose} />
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
          <MessageMenu at={message.at} tokens={message.tokens} thoughtMs={message.thoughtMs} prose={prose} raw={message.raw} rawNoOutput={message.rawNoOutput} onFork={onFork} turn={turn} busy={busy} onQuote={onQuote} />
        </div>
      )}
      {message.waitingSince !== undefined && !drawingADraft(parts) && <WaitLine label="Thinking" />}
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
 * What the model thought, and how long it took: a summary line, and the thought
 * under it, opened or folded as the display asks. The line is the control either
 * way, so a folded thought is one press from being read.
 *
 * The display is the rule, not a starting point: a change to it reaches every
 * thought on screen, including one the person opened by hand.
 */
function Reasoning({ text, thoughtMs, open }: { text: string; thoughtMs?: number; open: boolean }) {
  const [expanded, setExpanded] = useState(open)
  useEffect(() => { setExpanded(open) }, [open])
  return <div className={`reasoning ${expanded ? 'open' : ''}`}>
    <button className="reasoning-summary" type="button" aria-expanded={expanded} aria-label={expanded ? 'Hide thinking' : 'Show thinking'} onClick={() => setExpanded((value) => !value)}>
      {thoughtLabel(thoughtMs)}
    </button>
    <div className="reasoning-collapse"><div className="reasoning-clip"><div className="reasoning-body">{text}</div></div></div>
  </div>
}

/**
 * What the line over a thought says: how long the turn waited before it said
 * anything, when that is known and worth saying — the thought's own name otherwise.
 * The terminal's wording for the wait, so both surfaces say the same thing about it.
 */
function thoughtLabel(ms?: number): string {
  return ms !== undefined && ms >= 1000 ? `Thought for ${formatSeconds(ms / 1000)}` : 'Thought'
}

/**
 * What a message is and what can be done with it, behind the three dots: when it was
 * said, what an answer cost (tokens and thinking time, when the turn that produced it is
 * still the one on screen), the session forked up to that answer, and the way to answer
 * it as a whole.
 *
 * The panel is placed against the window rather than the thread: opened near an
 * edge it flips and slides to stay whole instead of spilling off the screen, and
 * a scroll moves it with its button rather than leaving it behind or cutting it
 * at the scroller's edge.
 */
function MessageMenu({ at, tokens, thoughtMs, prose, raw, rawNoOutput, onFork, turn, busy, onQuote }: {
  at?: number
  tokens?: { input: number; output: number }
  thoughtMs?: number
  prose: string
  /** The turn copied whole — words, thinking, tool calls and their results. Absent when
   *  the turn is only prose, which the plain Copy already covers. */
  raw?: string
  /** The same turn with the tool results' own text left out — the path it walked.
   *  Absent where it would read as the whole copy, so the second choice is offered only
   *  where it says something the first does not. */
  rawNoOutput?: string
  /** The session forked up to the turn this answer ended. It sits behind the dots with
   *  the rest of what a press can reach rather than in the toolbar, where a fork and a
   *  hover-only label crowded the very menu they belonged to. */
  onFork?(upToTurn: number): void
  /** Which turn this answer belongs to — what a fork copies up to. */
  turn?: number
  busy?: boolean
  onQuote?(text: string): void
}) {
  const [open, setOpen] = useState(false)
  const [copyOpen, setCopyOpen] = useState(false)
  const { state: withState, copy: copyWith } = useCopy(raw ?? '')
  const { state: withoutState, copy: copyWithout } = useCopy(rawNoOutput ?? '')
  const [spot, setSpot] = useState<{ left: number; top: number; up: boolean } | null>(null)
  const [subSpot, setSubSpot] = useState<{ left: number; top: number; leftOf: boolean } | null>(null)
  // Armed one frame after the panel mounts: an element that gets its entrance
  // animation in the very style pass it first appears in does not always travel,
  // so the growth is held a frame and then let go.
  const [shown, setShown] = useState(false)
  const [subShown, setSubShown] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const subRow = useRef<HTMLButtonElement>(null)
  const subPanel = useRef<HTMLDivElement>(null)

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
    if (!open) { setShown(false); setCopyOpen(false); return }
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!copyOpen) { setSubShown(false); return }
    const frame = requestAnimationFrame(() => setSubShown(true))
    return () => cancelAnimationFrame(frame)
  }, [copyOpen])

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

  useLayoutEffect(() => {
    if (!open || !copyOpen) { setSubSpot(null); return }
    const place = (): void => {
      const from = subRow.current?.getBoundingClientRect()
      const size = subPanel.current?.getBoundingClientRect()
      if (!from || !size) return
      const margin = 10
      const gap = 8
      // Beside the row it belongs to — to the right while that fits, to the left
      // otherwise — so the choices never open over the menu they came from.
      const leftOf = from.right + gap + size.width > window.innerWidth - margin
      const left = leftOf ? from.left - gap - size.width : from.right + gap
      const top = Math.min(Math.max(margin, from.top), Math.max(margin, window.innerHeight - size.height - margin))
      setSubSpot({ left: Math.max(margin, left), top, leftOf })
    }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, copyOpen])

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
      {hasInfo && (raw || onQuote || onFork) && <div className="message-menu-sep" />}
      {onFork && turn !== undefined && <button
        className="message-menu-action"
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onFork(turn)}
      >
        <Icon name="branch" size={15} />
        <span>Fork session from here</span>
      </button>}
      {/* The copy is one control with two choices, so this row opens them instead of
          copying: with the output is the turn whole, without it the path it walked.
          Either choice leaves the menu open — unlike Quote, which shows its work in the
          composer, a copy has nothing else to say it landed but its own label. */}
      {raw && <button
        ref={subRow}
        className={`message-menu-action has-more${copyOpen ? ' open' : ''}`}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={copyOpen}
        onClick={() => setCopyOpen((value) => !value)}
      >
        <Icon name="copy" size={15} />
        <span>Copy raw</span>
        <Icon className="menu-more" name="chevron" size={14} />
      </button>}
      {copyOpen && raw && <div
        ref={subPanel}
        className={`message-submenu${subShown ? ' in' : ''}${subSpot?.leftOf ? ' left' : ''}`}
        role="menu"
        aria-label="Copy raw"
        style={subSpot ? { left: subSpot.left, top: subSpot.top } : undefined}
      >
        <button className="message-menu-action" type="button" role="menuitem" onClick={copyWith}>
          <Icon name={withState === 'copied' ? 'check' : 'copy'} size={15} />
          <span>{copyLabelFor(withState, 'With output')}</span>
        </button>
        {rawNoOutput && <button className="message-menu-action" type="button" role="menuitem" onClick={copyWithout}>
          <Icon name={withoutState === 'copied' ? 'check' : 'copy'} size={15} />
          <span>{copyLabelFor(withoutState, 'Without output')}</span>
        </button>}
      </div>}
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

/** What a copy choice says: its own name, then the one note a copy has to give. */
function copyLabelFor(state: CopyState, name: string): string {
  if (state === 'copied') return 'Copied'
  if (state === 'failed') return 'Copy raw failed — select the text and copy it by hand'
  return name
}

/**
 * Whether the answer is showing a widget the model has not finished writing. The wait
 * is named only while nothing is arriving; a table filling in front of the person is
 * not a wait, whatever the turn is doing behind it.
 */
function drawingADraft(parts: TranscriptPart[]): boolean {
  for (let at = parts.length - 1; at >= 0; at -= 1) {
    const part = parts[at]!
    if (part.kind === 'ui') return part.draft === true
  }
  return false
}

function hasContent(message: ChatMessage): boolean {
  if (message.parts.some((part) => part.kind === 'text' && part.text.trim())) return true
  if (message.parts.some((part) => part.kind === 'tool' || part.kind === 'todo')) return true
  if (message.parts.some((part) => part.kind === 'ui')) return true
  if (message.parts.some((part) => part.kind === 'reasoning')) return true
  if (message.attachments && message.attachments.length > 0) return true
  if (message.cards && message.cards.length > 0) return true
  if (message.actions && message.actions.length > 0) return true
  if (message.waitingSince !== undefined) return true
  if (message.status) return true
  return false
}
