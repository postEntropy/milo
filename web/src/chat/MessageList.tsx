import { useState } from 'react'
import type { FrameAttachment, TranscriptMessage } from '@protocol'
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

function ToolLines({ id, tools }: { id: string; tools: string[] }) {
  const seen = new Map<string, number>()
  return <>{tools.map((tool) => {
    const occurrence = seen.get(tool) ?? 0
    seen.set(tool, occurrence + 1)
    return <div className="tool-line" key={`${id}-${tool}-${occurrence}`}><code>{tool}</code></div>
  })}</>
}

export function MessageList({ messages, thinking, onPrompt }: { messages: ChatMessage[]; thinking: boolean; onPrompt?(text: string): void }) {
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
    {messages.map((message) => (
      <article className={`message ${message.role}${message.loaded ? ' is-loaded' : ''}`} key={message.id}>
        <div className="message-content">
          {message.reasoning && thinking
            ? <Reasoning text={message.reasoning} thoughtMs={message.thoughtMs} />
            : message.thoughtMs !== undefined && message.thoughtMs >= 1000
              ? <div className="reasoning-note"><Icon name="spark" size={14} /> {thoughtLabel(message.thoughtMs)}</div>
              : null}
          {message.tools && message.tools.length > 0 && <ToolLines id={message.id} tools={message.tools} />}
          {message.attachments && message.attachments.length > 0 && <Attachments items={message.attachments} />}
          {message.text && <Markdown text={message.text} />}
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
