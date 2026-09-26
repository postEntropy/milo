import type { TranscriptMessage } from '@protocol'
import { Markdown } from './Markdown.js'
import { Icon } from '../ui/Icons.js'
import { miloAvatar } from '../ui/milo.js'

export interface ChatMessage extends TranscriptMessage {
  id: string
  status?: string
  tools?: string[]
  /** Already on screen when the session was opened, so it does not settle in again. */
  loaded?: boolean
}

const suggestions = [
  { icon: 'file', title: 'Summarize a file', detail: 'Read and explain a document', prompt: 'Help me summarize a file in this project.' },
  { icon: 'terminal', title: 'Investigate an error', detail: 'Step-by-step diagnosis', prompt: 'Help me investigate this build error.' },
  { icon: 'settings', title: 'Tune Milo', detail: 'Set up the model and tools', prompt: 'I want to adjust Milo’s settings.' },
  { icon: 'spark', title: 'Plan a change', detail: 'Break it into safe steps', prompt: 'Help me plan a change in the project.' },
] as const

function ToolLines({ id, tools }: { id: string; tools: string[] }) {
  const seen = new Map<string, number>()
  return <>{tools.map((tool) => {
    const occurrence = seen.get(tool) ?? 0
    seen.set(tool, occurrence + 1)
    return <div className="tool-line" key={`${id}-${tool}-${occurrence}`}><Icon name="settings" size={14} /><code>{tool}</code></div>
  })}</>
}

export function MessageList({ messages, thinking, onPrompt }: { messages: ChatMessage[]; thinking: boolean; onPrompt(text: string): void }) {
  if (messages.length === 0) return (
    <section className="empty-state" aria-labelledby="welcome-title">
      <img className="empty-brand" src={miloAvatar} alt="" />
      <h1 id="welcome-title">How can I help today?</h1>
      <div className="suggestion-grid">
        {suggestions.map((item) => (
          <button className="suggestion" key={item.title} type="button" onClick={() => onPrompt(item.prompt)}>
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
        {message.role === 'assistant' && <img className="assistant-mark" src={miloAvatar} alt="" />}
        <div className="message-content">
          {message.role === 'user' && <div className="message-label">You</div>}
          {message.reasoning && thinking && <details className="reasoning"><summary><Icon name="spark" size={15} /> Reasoning <Icon className="reasoning-chevron" name="chevron" size={14} /></summary><div className="reasoning-body">{message.reasoning}</div></details>}
          {message.tools && message.tools.length > 0 && <ToolLines id={message.id} tools={message.tools} />}
          {message.text && <Markdown text={message.text} />}
          {message.status && <div className="message-status">{message.status}</div>}
        </div>
      </article>
    ))}
  </div>
}
