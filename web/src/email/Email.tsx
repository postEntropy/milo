import DOMPurify from 'dompurify'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { formatWhen, message } from '../lib/format.js'
import { Field } from '../ui/Form.js'
import { Icon } from '../ui/Icons.js'
import { Notice, useAutoDismiss } from '../ui/Notice.js'

/**
 * An access level, in the same order `src/core/google/tiers.ts` declares. Kept as
 * a plain list here so the screen can compare levels without a round trip; the
 * labels it draws come from the server's own tiers.
 */
type Access = 'none' | 'modify' | 'compose' | 'send'
const ORDER: Access[] = ['none', 'modify', 'compose', 'send']

/** Whether a grant at `access` covers an action that needs `need`. */
function can(access: Access | undefined, need: Access): boolean {
  return access !== undefined && ORDER.indexOf(access) >= ORDER.indexOf(need)
}

type Tier = { id: Access; label: string; description: string }

type Status =
  | { kind: 'off'; tiers: Tier[] }
  | { kind: 'wanted'; tiers: Tier[] }
  | { kind: 'connected'; email?: string; access: Access; tiers: Tier[] }

type MailSummary = { id: string; threadId: string; date?: string; from?: string; subject?: string; snippet?: string; labelIds?: string[] }
type MailMessage = MailSummary & { text: string; truncated: boolean; html: boolean }
type MailThread = { id: string; messages: MailMessage[] }
type Draft = { to: string; subject: string; body: string; threadId?: string }
/** A message being written from scratch, before anything is typed. */
const EMPTY_DRAFT: Draft = { to: '', subject: '', body: '' }

/** What an action says once it lands, so the notice names the thing that happened. */
const DONE: Record<string, string> = {
  archive: 'Archived.',
  read: 'Marked read.',
  unread: 'Marked unread.',
}

/** The address inside a `From` header, `Ana <ana@exemplo>` reduced to `ana@exemplo`. */
function addressOf(from: string | undefined): string {
  if (!from) return ''
  const angled = /<([^>]+)>/.exec(from)
  return angled ? angled[1]!.trim() : from.trim()
}

/**
 * The sender as the list draws it: the display name when the header carries one,
 * and otherwise the part before the "@". The whole address beside a name is noise
 * in a list you scan — the `@` and the domain are not what the eye is reading.
 *
 * Only the display goes through here: `addressOf` still hands the real address to
 * a reply, so nothing is lost by shortening what is shown. To go back to the full
 * `From` header, return `from` unchanged.
 */
function displaySender(from: string | undefined): string {
  if (!from) return '(no sender)'
  const name = /^([^<]*)</.exec(from)?.[1]?.trim().replace(/^"(.*)"$/, '$1')
  if (name) return name
  const address = addressOf(from)
  return address.includes('@') ? address.split('@')[0]! : address
}

/** A mail date, which Gmail writes as RFC 2822 rather than an epoch. */
function mailDate(value: string | undefined): string {
  if (!value) return ''
  const at = Date.parse(value)
  return Number.isNaN(at) ? value : formatWhen(at)
}

/**
 * The Email view: an inbox, one thread, and the actions the grant allows. Write
 * actions live only here — the agent's own Gmail tools stay read-only — so what a
 * grant can do is drawn on the control rather than guessed at.
 *
 * What is on screen is the address bar's: `route` is null for the inbox, `new`
 * for the composer, and otherwise a thread id. That is what lets the browser's own
 * Back leave a thread for the inbox instead of leaving the app.
 */
export function Email({ route, onRoute }: { route: string | null; onRoute(next: string | null): void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [inbox, setInbox] = useState<MailSummary[] | null>(null)
  const [nextPage, setNextPage] = useState<string | undefined>(undefined)
  const [thread, setThread] = useState<MailThread | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [assist, setAssist] = useState<{ title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)

  const connected = status?.kind === 'connected' ? status : null
  const access = connected?.access
  const composing = route === 'new'
  const threadId = route !== null && route !== 'new' ? route : null

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api<Status>('email-status'))
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }, [])

  const loadInbox = useCallback(async (pageToken?: string): Promise<void> => {
    try {
      const page = await api<{ messages: MailSummary[]; nextPageToken?: string }>(
        'email-inbox',
        pageToken ? { pageToken } : {},
      )
      setInbox((current) => (pageToken && current ? [...current, ...page.messages] : page.messages))
      setNextPage(page.nextPageToken)
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Read the inbox once the grant turns out to be connected — not before, so a
  // screen with no account never shows a failed fetch it did not need.
  useEffect(() => {
    if (connected && inbox === null) void loadInbox()
  }, [connected, inbox, loadInbox])

  // The thread the address bar names. Leaving it — Back, or the Inbox button —
  // drops it, and the list is what is left.
  useEffect(() => {
    if (!connected || threadId === null) return
    let live = true
    setAssist(null)
    void api<MailThread>('email-thread', { threadId })
      .then((loaded) => { if (live) setThread(loaded) })
      .catch((error) => { if (live) setNotice({ text: message(error), error: true }) })
    return () => { live = false }
  }, [threadId, connected])

  /** A label change, then the inbox is read again so the list shows what happened. */
  async function modify(id: string, op: string): Promise<void> {
    try {
      await api('email-modify', { id, op })
      await loadInbox()
      setNotice({ text: DONE[op] ?? 'Done.', error: false })
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

  /** A reply, addressed back at the sender and threaded onto the same conversation. */
  function reply(to: MailMessage): void {
    setDraft({
      to: addressOf(to.from),
      subject: to.subject ? (to.subject.toLowerCase().startsWith('re:') ? to.subject : `Re: ${to.subject}`) : '',
      body: '',
      threadId: to.threadId,
    })
    onRoute('new')
  }

  /** Back to the inbox from anywhere in the screen's own path. */
  function toInbox(): void {
    setDraft(null)
    setAssist(null)
    onRoute(null)
  }

  async function saveDraft(): Promise<void> {
    if (!draft) return
    try {
      await api('email-draft', { draft })
      setNotice({ text: 'Draft saved to Gmail.', error: false })
      toInbox()
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

  async function send(): Promise<void> {
    if (!draft) return
    // The only irreversible, outward action here, so it is the one that asks first.
    if (!window.confirm(`Send this message to ${draft.to}?`)) return
    try {
      await api('email-send', { draft })
      setNotice({ text: 'Sent.', error: false })
      toInbox()
      await loadInbox()
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

  /** The agentic layer: the model reads what is on screen and answers about it. */
  async function ask(mode: 'triage' | 'summarize', title: string, body: Record<string, unknown>): Promise<void> {
    setBusy(true)
    setAssist(null)
    try {
      const result = await api<{ text: string }>('email-assist', { mode, ...body })
      setAssist({ title, text: result.text })
    } catch (error) {
      setNotice({ text: message(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  /** A reply the model wrote, opened as a draft the person can edit before sending. */
  async function draftReply(): Promise<void> {
    const last = thread?.messages[thread.messages.length - 1]
    if (!last || !thread) return
    setBusy(true)
    setAssist(null)
    try {
      const result = await api<{ text: string }>('email-assist', { mode: 'draft', threadId: thread.id })
      setDraft({
        to: addressOf(last.from),
        subject: last.subject
          ? (last.subject.toLowerCase().startsWith('re:') ? last.subject : `Re: ${last.subject}`)
          : '',
        body: result.text,
        threadId: thread.id,
      })
      onRoute('new')
    } catch (error) {
      setNotice({ text: message(error), error: true })
    } finally {
      setBusy(false)
    }
  }

  const head = <div className="panel-head mail-head">
    {route !== null
      ? <button className="settings-back" type="button" onClick={toInbox}><Icon name="arrow-left" /><span>Inbox</span></button>
      : <h2 className="mail-title">Inbox</h2>}
    {connected && route === null && <div className="panel-count">
      <strong>{inbox?.length ?? 0}</strong><span>shown</span>
      <span className="panel-count-divider" />
      <button className="mail-head-action" type="button" title="Refresh" aria-label="Refresh the inbox" onClick={() => void loadInbox()}><Icon name="refresh" size={16} /></button>
      <button className="mail-head-action" type="button" title="New message" aria-label="New message" disabled={!can(access, 'compose')} onClick={() => { setDraft(EMPTY_DRAFT); onRoute('new') }}><Icon name="edit" size={16} /></button>
    </div>}
  </div>

  return <main className="settings-workspace mail-workspace">
    <div className="settings-inner mail-inner">
      <div className="settings-panel-stack">
        <section className="settings-section mail-section">
          {head}
          <Notice notice={notice} onDismiss={() => setNotice(null)} />
          <div className="panel-body">
            {status === null
              ? <p className="list-empty">Reading the connection…</p>
              : connected === null
              ? <NotConnected status={status} />
              : composing
              ? <Compose draft={draft ?? EMPTY_DRAFT} access={access} onChange={setDraft} onSave={() => void saveDraft()} onSend={() => void send()} onDiscard={toInbox} />
              : threadId !== null
              ? thread?.id === threadId
                ? <ThreadView thread={thread} access={access} busy={busy} onReply={reply} onDraft={() => void draftReply()} onModify={modify} onAsk={ask} />
                : <p className="list-empty">Reading the thread…</p>
              : <Inbox inbox={inbox} access={access} onOpen={(mail) => onRoute(mail.threadId)} onModify={modify} onMore={() => void loadInbox(nextPage)} nextPage={nextPage} busy={busy} onAsk={ask} />}
            {assist && <section className="mail-assist">
              <h3>{assist.title}</h3>
              <p className="mail-assist-text">{assist.text || 'The model had nothing to add.'}</p>
              <button className="button" type="button" onClick={() => setAssist(null)}>Dismiss</button>
            </section>}
          </div>
        </section>
      </div>
    </div>
  </main>
}

/** What to do before there is anything to draw: the one command, and the levels. */
function NotConnected({ status }: { status: Status }) {
  return <div className="panel-empty">
    <span className="panel-empty-mark"><Icon name="mail" size={22} /></span>
    <h3>{status.kind === 'wanted' ? 'Google is on, but no account answered' : 'Connect Gmail'}</h3>
    <p className="panel-empty-copy">
      Reading and acting on mail needs a Google account connected to this Milo. On the machine that
      runs it:
    </p>
    <code className="mail-command">milo google connect</code>
    <p className="panel-empty-copy">
      It asks how much access to allow — {status.tiers.map((tier) => tier.label).join(', ')}. Reading
      is the base, and you can reconnect for more.
    </p>
  </div>
}

function Inbox({
  inbox,
  access,
  onOpen,
  onModify,
  onMore,
  nextPage,
  busy,
  onAsk,
}: {
  inbox: MailSummary[] | null
  access: Access | undefined
  onOpen(summary: MailSummary): void
  onModify(id: string, op: string): void
  onMore(): void
  nextPage?: string
  busy: boolean
  onAsk(mode: 'triage', title: string, body: Record<string, unknown>): void
}) {
  if (inbox === null) return <p className="list-empty">Reading the inbox…</p>
  if (inbox.length === 0) return <div className="panel-empty">
    <span className="panel-empty-mark"><Icon name="inbox" size={22} /></span>
    <h3>The inbox is empty</h3>
    <p className="panel-empty-copy">Nothing is in the inbox right now.</p>
  </div>
  return <>
    <div className="mail-toolbar">
      <button className="button" type="button" disabled={busy} onClick={() => onAsk('triage', 'Unread summary', {})}>
        <Icon name="spark" size={15} /> Summarize unread
      </button>
    </div>
    <div className="mail-list">
      {inbox.map((mail) => {
        // Gmail marks unread by carrying `UNREAD`, so one control can do both
        // directions and show which one it will do.
        const unread = mail.labelIds?.includes('UNREAD') ?? false
        return <div className="mail-row" key={mail.id}>
          <button className="mail-row-open" type="button" onClick={() => onOpen(mail)}>
            <span className="mail-row-from">{displaySender(mail.from)}</span>
            <span className="mail-row-subject">{mail.subject ?? '(no subject)'}</span>
          </button>
          <span className="mail-row-when">{mailDate(mail.date)}</span>
          <span className="mail-row-actions">
            <button className="mail-row-action" type="button" title={can(access, 'modify') ? 'Archive' : 'Archive needs “Tidy up” access'} aria-label="Archive" disabled={!can(access, 'modify')} onClick={() => onModify(mail.id, 'archive')}><Icon name="archive" size={15} /></button>
            <button className="mail-row-action" type="button" title={can(access, 'modify') ? (unread ? 'Mark read' : 'Mark unread') : 'Needs “Tidy up” access'} aria-label={unread ? 'Mark read' : 'Mark unread'} disabled={!can(access, 'modify')} onClick={() => onModify(mail.id, unread ? 'read' : 'unread')}><Icon name={unread ? 'circle-dot' : 'circle'} size={15} /></button>
          </span>
        </div>
      })}
    </div>
    {nextPage && <div className="mail-more"><button className="button" type="button" onClick={onMore}>Load more</button></div>}
  </>
}

/**
 * The page a mail body is drawn on: white, Gmail-like, and its own document — so an
 * email's `<style>`, classes, tables and fonts lay out the way the sender meant
 * them, without reaching the app around it.
 */
const MAIL_RESET = [
  'html,body{margin:0;padding:0}',
  'body{background:#fff;color:#202124;font:13px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;word-break:break-word}',
  'img{max-width:100%;height:auto}',
  'table{max-width:100%}',
  'a{color:#1a73e8}',
].join('')

/**
 * One message's body. Text is drawn as it is; an HTML part is sanitized and then
 * rendered in a sandboxed frame — the way a mail client draws mail, and the only
 * way an email's own stylesheet can apply without escaping into the app. The frame
 * runs no scripts, opens no forms, and sends no referrer.
 */
const MailBody = memo(function MailBody({ message }: { message: MailMessage }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(0)

  const doc = useMemo(() => {
    if (!message.html) return null
    // Added and taken back around this one call, so mail is hardened without
    // changing how the chat renders a model answer.
    const harden = (node: Element): void => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noreferrer noopener')
      } else if (node.tagName === 'IMG') {
        node.setAttribute('loading', 'lazy')
        node.setAttribute('referrerpolicy', 'no-referrer')
      }
    }
    DOMPurify.addHook('afterSanitizeAttributes', harden)
    try {
      const clean = DOMPurify.sanitize(message.text, {
        WHOLE_DOCUMENT: true,
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['script', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base'],
        FORBID_ATTR: ['srcset', 'ping', 'formaction'],
        ADD_ATTR: ['target', 'rel', 'loading', 'referrerpolicy'],
      })
      // The email's own head is kept; ours is added to it — the charset, the
      // no-referrer rule, links opening away from the frame, and the base page.
      const ours = `<meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${MAIL_RESET}</style>`
      return /<head[^>]*>/i.test(clean) ? clean.replace(/<head([^>]*)>/i, `<head$1>${ours}`) : clean
    } finally {
      DOMPurify.removeHook('afterSanitizeAttributes', harden)
    }
  }, [message.text, message.html])

  // The frame is same-origin with no scripts, so its real height can be read back
  // and followed as images land — a fixed box would clip the message.
  useEffect(() => {
    if (doc === null) return
    const node = frame.current
    if (!node) return
    setHeight(0)
    let observer: ResizeObserver | null = null
    const measure = (): void => {
      const root = node.contentDocument?.documentElement
      if (root) setHeight(root.scrollHeight)
    }
    const attach = (): void => {
      measure()
      const root = node.contentDocument?.documentElement
      if (root && typeof ResizeObserver !== 'undefined') {
        observer?.disconnect()
        observer = new ResizeObserver(measure)
        observer.observe(root)
      }
    }
    node.addEventListener('load', attach)
    if (node.contentDocument?.readyState === 'complete') attach()
    return () => {
      node.removeEventListener('load', attach)
      observer?.disconnect()
    }
  }, [doc])

  if (doc === null) return <div className="mail-message-body">{message.text || '(this message has no readable body)'}</div>
  return <div className="mail-message-body mail-frame-wrap">
    <iframe
      ref={frame}
      className="mail-frame"
      title={message.subject ?? 'Message'}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      style={{ height: height || 160 }}
    />
  </div>
})

function ThreadView({
  thread,
  access,
  busy,
  onReply,
  onDraft,
  onModify,
  onAsk,
}: {
  thread: MailThread
  access: Access | undefined
  busy: boolean
  onReply(message: MailMessage): void
  onDraft(): void
  onModify(id: string, op: string): void
  onAsk(mode: 'summarize', title: string, body: Record<string, unknown>): void
}) {
  const last = thread.messages[thread.messages.length - 1]
  return <>
    <div className="mail-thread-actions">
      <button className="button" type="button" disabled={busy} onClick={() => onAsk('summarize', 'Thread summary', { threadId: thread.id })}><Icon name="spark" size={15} /> Summarize</button>
      <button className="button" type="button" disabled={busy || !can(access, 'compose')} title={can(access, 'compose') ? undefined : 'Drafting needs “Write drafts” access'} onClick={onDraft}><Icon name="reply" size={15} /> Draft with Milo</button>
      <button className="button" type="button" disabled={!can(access, 'modify')} title={can(access, 'modify') ? undefined : 'Needs “Tidy up” access'} onClick={() => last && onModify(last.id, 'archive')}><Icon name="archive" size={15} /> Archive</button>
      <button className="button" type="button" disabled={!can(access, 'modify')} title={can(access, 'modify') ? undefined : 'Needs “Tidy up” access'} onClick={() => last && onModify(last.id, 'unread')}>Mark unread</button>
      <button className="button primary" type="button" disabled={!can(access, 'compose') || !last} title={can(access, 'compose') ? undefined : 'Replies need “Write drafts” access'} onClick={() => last && onReply(last)}>Reply</button>
    </div>
    <div className="mail-thread">
      {thread.messages.map((mail) => <article className="mail-message" key={mail.id}>
        <div className="mail-message-head">
          <strong className="mail-sender">{displaySender(mail.from)}</strong>
          <span className="mail-when">{mailDate(mail.date)}</span>
        </div>
        <div className="mail-message-subject">{mail.subject ?? '(no subject)'}</div>
        <MailBody message={mail} />
        {mail.truncated && <p className="mail-message-note">The body was cut — open it in Gmail to read the rest.</p>}
      </article>)}
    </div>
  </>
}

function Compose({
  draft,
  access,
  onChange,
  onSave,
  onSend,
  onDiscard,
}: {
  draft: Draft
  access: Access | undefined
  onChange(draft: Draft): void
  onSave(): void
  onSend(): void
  onDiscard(): void
}) {
  return <div className="mail-compose">
    <Field label="To">
      <input value={draft.to} placeholder="someone@example.com" onChange={(event) => onChange({ ...draft, to: event.target.value })} />
    </Field>
    <Field label="Subject">
      <input value={draft.subject} onChange={(event) => onChange({ ...draft, subject: event.target.value })} />
    </Field>
    <Field label="Message">
      <textarea rows={12} value={draft.body} onChange={(event) => onChange({ ...draft, body: event.target.value })} />
    </Field>
    <div className="ask-actions">
      <button className="button" type="button" disabled={!can(access, 'compose')} onClick={onSave}>Save draft</button>
      <button className="button primary" type="button" disabled={!can(access, 'send') || !draft.to.trim() || !draft.body.trim()} onClick={onSend}>Send</button>
      <button className="button" type="button" onClick={onDiscard}>Discard</button>
    </div>
    {!can(access, 'send') && <p className="mail-tier-note">
      {can(access, 'compose')
        ? 'Sending needs “Send mail” access — reconnect with `milo google connect --access send`.'
        : 'Writing drafts needs “Write drafts” access — reconnect with `milo google connect --access compose`.'}
    </p>}
  </div>
}
