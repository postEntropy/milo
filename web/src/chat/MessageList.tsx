import { useState } from 'react'
import type { ActionRow, FrameAttachment, SessionCardItem, TranscriptMessage } from '@protocol'
import { attachmentUrl } from '../lib/api.js'
import { Markdown } from './Markdown.js'
import { Icon } from '../ui/Icons.js'
import { miloAvatar } from '../ui/milo.js'

export interface ChatMessage extends TranscriptMessage {
  id: string
  status?: string
  tools?: string[]
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

const suggestions = [
  { icon: 'file', title: 'Summarize a file', detail: 'Read and explain a document', prompt: 'Help me summarize a file in this project.' },
  { icon: 'terminal', title: 'Investigate an error', detail: 'Step-by-step diagnosis', prompt: 'Help me investigate this build error.' },
  { icon: 'settings', title: 'Tune Milo', detail: 'Set up the model and tools', prompt: 'I want to adjust Milo’s settings.' },
  { icon: 'spark', title: 'Plan a change', detail: 'Break it into safe steps', prompt: 'Help me plan a change in the project.' },
] as const

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

function ToolLine({ tool }: { tool: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(tool)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard write might fail in unpermitted context
    }
  }

  return (
    <div className="tool-line">
      <code>{tool}</code>
      <button
        className="tool-copy-btn"
        type="button"
        title={copied ? 'Copied' : 'Copy command'}
        aria-label={copied ? 'Copied' : 'Copy command'}
        onClick={() => void handleCopy()}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </div>
  )
}

function ToolLines({ id, tools }: { id: string; tools: string[] }) {
  const seen = new Map<string, number>()
  return <>{tools.map((tool) => {
    const occurrence = seen.get(tool) ?? 0
    seen.set(tool, occurrence + 1)
    return <ToolLine key={`${id}-${tool}-${occurrence}`} tool={tool} />
  })}</>
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

export function MessageList({ messages, thinking, onPrompt, onAction }: { messages: ChatMessage[]; thinking: boolean; onPrompt?(text: string): void; onAction?(actionId: string, messageId?: string): void }) {
  if (messages.length === 0) return (
    <section className="empty-state" aria-labelledby="welcome-title">
      <img className="empty-brand" src={miloAvatar} alt="" />
      <h1 id="welcome-title">How can I help today?</h1>
      <div className="suggestion-grid">
        {suggestions.map((item) => (
          <button className="suggestion" key={item.title} type="button" onClick={() => onPrompt?.(item.prompt)}>
            <Icon name={item.icon} size={19} />
            <span><strong>{item.title}</strong><small>{item.detail}</small></span>
            <Icon className="suggestion-arrow" name="chevron" size={16} />
          </button>
        ))}
      </div>
    </section>
  )

  return <div className="thread-inner" aria-live="polite" aria-relevant="additions text">
    {messages.filter((m) => hasContent(m, thinking)).map((message) => (
      <article className={`message ${message.role}${message.loaded ? ' is-loaded' : ''}`} key={message.id}>
        <div className="message-content">
          {message.reasoning && thinking
            ? <Reasoning text={message.reasoning} thoughtMs={message.thoughtMs} />
            : message.thoughtMs !== undefined && message.thoughtMs >= 1000
              ? <div className="reasoning-note"><Icon name="spark" size={14} /> {thoughtLabel(message.thoughtMs)}</div>
              : null}
          {message.tools && message.tools.length > 0 && <ToolLines id={message.id} tools={message.tools} />}
          {message.attachments && message.attachments.length > 0 && <Attachments items={message.attachments} />}
          {message.cards && message.cards.length > 0 ? (
            <SessionCards
              cards={message.cards}
              onSelect={(id) => onAction?.(`resume:${id}`, message.id)}
            />
          ) : (
            message.text && <Markdown text={message.text} />
          )}
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
          {message.role === 'assistant' && message.text && message.waitingSince === undefined && (
            <div className="message-toolbar">
              <CopyButton text={message.text} />
            </div>
          )}
          {message.waitingSince !== undefined && <WaitLine />}
          {message.status && <div className="message-status">{message.status}</div>}
        </div>
      </article>
    ))}
  </div>
}

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
function Reasoning({ text, thoughtMs }: { text: string; thoughtMs?: number }) {
  const [open, setOpen] = useState(true)
  return <details className="reasoning" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><Icon name="spark" size={15} /> {thoughtLabel(thoughtMs)} <Icon className="reasoning-chevron" name="chevron" size={14} /></summary>
    <div className="reasoning-body">{text}</div>
  </details>
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
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard write might fail in non-secure origins
    }
  }

  return (
    <button
      className="message-tool-btn"
      type="button"
      title={copied ? 'Copied' : 'Copy message'}
      aria-label={copied ? 'Copied' : 'Copy message'}
      onClick={() => void handleCopy()}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {copied && <span className="message-tool-label">Copied</span>}
    </button>
  )
}

function hasContent(message: ChatMessage, thinking: boolean): boolean {
  if (message.text?.trim()) return true
  if (message.tools && message.tools.length > 0) return true
  if (message.attachments && message.attachments.length > 0) return true
  if (message.cards && message.cards.length > 0) return true
  if (message.actions && message.actions.length > 0) return true
  if (message.reasoning && thinking) return true
  if (message.waitingSince !== undefined) return true
  if (message.status) return true
  return false
}
