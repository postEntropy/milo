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

/** One of the inbox's quick filters, as the server names it. */
type MailFilter = { id: string; label: string }

type Status =
  | { kind: 'off'; tiers: Tier[]; filters: MailFilter[] }
  | { kind: 'wanted'; tiers: Tier[]; filters: MailFilter[] }
  | { kind: 'connected'; email?: string; access: Access; tiers: Tier[]; filters: MailFilter[]; sorting: boolean }

type MailLabel = { id: string; name: string; color: string }
type MailSummary = { id: string; threadId: string; date?: string; from?: string; subject?: string; snippet?: string; labelIds?: string[]; labels?: MailLabel[] }
type MailMessage = MailSummary & { text: string; truncated: boolean; html: boolean; nextOffset?: number }
type MailThread = { id: string; messages: MailMessage[] }
type InboxPage = { messages: MailSummary[]; nextPageToken?: string; labels: MailLabel[]; colors: string[]; unsorted?: string[] }
/** What sorting a page came back with: labels per message id, and the set they came from. */
type SortResult = { byMessage: Record<string, MailLabel[]>; labels: MailLabel[] }
/** A body read past the thread's cut: the text, and where the next chunk starts. */
type BodyChunk = { id: string; text: string; html: boolean; truncated: boolean; nextOffset?: number }
type Draft = { to: string; subject: string; body: string; threadId?: string }
/** A message being written from scratch, before anything is typed. */
const EMPTY_DRAFT: Draft = { to: '', subject: '', body: '' }

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

/** A message with one label added or dropped, leaving the rest of what it carries. */
function withLabel<T extends MailSummary>(mail: T, label: MailLabel, on: boolean): T {
  const current = mail.labels ?? []
  const labels = on ? [...current.filter((entry) => entry.id !== label.id), label] : current.filter((entry) => entry.id !== label.id)
  return { ...mail, labels }
}

/** A message with its read state set — Gmail marks unread by carrying `UNREAD`. */
function withUnread<T extends MailSummary>(mail: T, unread: boolean): T {
  const current = mail.labelIds ?? []
  const labelIds = unread
    ? (current.includes('UNREAD') ? current : [...current, 'UNREAD'])
    : current.filter((id) => id !== 'UNREAD')
  return { ...mail, labelIds }
}

/**
 * The Email view: an inbox, one thread, and the actions the grant allows. The
 * screen's write actions live only here and go through the server; the agent
 * reaches mail through its own Gmail tools — so what a grant can do is drawn on
 * the control rather than guessed at.
 *
 * What is on screen is the address bar's: `route` is null for the inbox, `new`
 * for the composer, and otherwise a thread id. That is what lets the browser's own
 * Back leave a thread for the inbox instead of leaving the app.
 */
export function Email({ active, route, onRoute, onSeen }: { active: boolean; route: string | null; onRoute(next: string | null): void; onSeen(): void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [inbox, setInbox] = useState<MailSummary[] | null>(null)
  const [nextPage, setNextPage] = useState<string | undefined>(undefined)
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [colors, setColors] = useState<string[]>([])
  const [labelFilter, setLabelFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  /** What was searched, a beat after typing stops — the value the list is read for. */
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string | null>(null)
  const [thread, setThread] = useState<MailThread | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [assist, setAssist] = useState<{ title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  /** Whether the next page is being fetched — the list scrolls into it on its own. */
  const [pageLoading, setPageLoading] = useState(false)
  /** Which message is having its body read past the thread's cut. */
  const [readingMore, setReadingMore] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)
  /** Whether Milo sorts the mail at all, read from the status — held in a ref so the
      inbox load does not change identity (and re-run) when the status lands. */
  const sortingRef = useRef(false)

  const connected = status?.kind === 'connected' ? status : null
  const access = connected?.access
  const composing = route === 'new'
  const threadId = route !== null && route !== 'new' ? route : null
  /** Whether something is hiding mail, so an empty list knows which empty it is. */
  const narrowed = query !== '' || filter !== null || labelFilter !== null
  /**
   * What narrows the list, as one value. A change to it is a different reading, so the
   * list is emptied for it; the same one keeps what is on screen while it is read again
   * — which is what lets a return to the screen draw mail instead of a loading line.
   */
  const narrowing = JSON.stringify([labelFilter, filter, query])
  const narrowingRef = useRef(narrowing)
  /** The panel itself, which is what scrolls — so a fresh page can start at the top. */
  const workspace = useRef<HTMLElement>(null)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await api<Status>('email-status')
      setStatus(next)
      sortingRef.current = next.kind === 'connected' && next.sorting
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }, [])

  /**
   * Asks the server to sort the rows the inbox could not place, and folds the labels
   * back onto them. Its own call, after the mail is already drawn, so a slow or down
   * classifier delays the labels and never the list.
   */
  const sortRows = useCallback(async (rows: MailSummary[], ids: string[]): Promise<void> => {
    if (!sortingRef.current || ids.length === 0) return
    const wanted = new Set(ids)
    try {
      const result = await api<SortResult>('email-sort', {
        messages: rows
          .filter((row) => wanted.has(row.id))
          .map(({ id, threadId, from, subject, snippet }) => ({ id, threadId, from, subject, snippet })),
      })
      setLabels(result.labels)
      setInbox((current) => current?.map((mail) => (result.byMessage[mail.id] ? { ...mail, labels: result.byMessage[mail.id] } : mail)) ?? current)
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }, [])

  const loadInbox = useCallback(async (pageToken?: string): Promise<void> => {
    try {
      const page = await api<InboxPage>('email-inbox', {
        ...(pageToken ? { pageToken } : {}),
        ...(labelFilter ? { labelId: labelFilter } : {}),
        ...(filter ? { filter } : {}),
        ...(query ? { search: query } : {}),
      })
      setLabels(page.labels)
      setColors(page.colors)
      setInbox((current) => (pageToken && current ? [...current, ...page.messages] : page.messages))
      setNextPage(page.nextPageToken)
      // A fresh read is the newest page; the top is where it is read from — the same place
      // rebuilding the view used to land, which is what a kept-mounted view must keep doing.
      if (!pageToken) workspace.current?.scrollTo({ top: 0 })
      // The rows with no label yet are sorted after the mail is on screen, never before.
      void sortRows(page.messages, page.unsorted ?? [])
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }, [labelFilter, filter, query, sortRows])

  // One page in flight at a time: the observer below can fire again before the first
  // answer lands, and two calls for the same cursor would double the rows.
  const loadingMore = useRef(false)
  const loadMore = useCallback((): void => {
    if (!nextPage || loadingMore.current) return
    const token = nextPage
    loadingMore.current = true
    setPageLoading(true)
    void loadInbox(token).finally(() => {
      loadingMore.current = false
      setPageLoading(false)
    })
  }, [nextPage, loadInbox])

  // What was typed becomes the query a beat after typing stops, so a search is one
  // Gmail call rather than one per keystroke.
  useEffect(() => {
    const typed = search.trim()
    const timer = window.setTimeout(() => setQuery(typed), 350)
    return () => window.clearTimeout(timer)
  }, [search])

  // Read the grant when the view is entered — not before it is ever opened, so a screen
  // nobody asked for never reads the account, and not while it is hidden.
  useEffect(() => {
    if (active) void loadStatus()
  }, [active, loadStatus])

  // Read the inbox once the grant turns out to be connected — not before, so a
  // screen with no account never shows a failed fetch it did not need. Changing the
  // label filter reads it again, from the top, so the list shows only that label.
  useEffect(() => {
    if (!connected || !active) return
    // A different narrowing empties the list, so the loading line is honest; the same one
    // keeps it, and the fresh page lands behind the mail already on screen.
    if (narrowingRef.current !== narrowing) setInbox(null)
    narrowingRef.current = narrowing
    void loadInbox()
  }, [connected, active, narrowing, loadInbox])

  // Showing the inbox is what "noticed" means: the sidebar's badge counts from here,
  // and the write is server-side, so this only tells the app it can clear it. A thread
  // opened by its own address (`/email/<id>`) never drew the list, so it does not count.
  useEffect(() => {
    if (!active || !connected || route !== null) return
    let live = true
    void api('email-seen')
      .then(() => { if (live) onSeen() })
      .catch((error) => { if (live) setNotice({ text: message(error), error: true }) })
    return () => { live = false }
  }, [active, connected, route, onSeen])

  /** A new label of the person's own, local to Milo. */
  async function createLabel(name: string, color: string): Promise<void> {
    try {
      const result = await api<{ labels: MailLabel[]; colors: string[] }>('email-label-create', { name, color })
      setLabels(result.labels)
      setColors(result.colors)
      setNotice({ text: `Added the label ${name}.`, error: false })
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

  /** Drops a label and everything it was on. Milo's own, so no grant is needed. */
  async function removeLabel(id: string): Promise<void> {
    const label = labels.find((entry) => entry.id === id)
    if (!window.confirm(`Delete the label ${label?.name ?? id}? It comes off every message.`)) return
    try {
      const result = await api<{ labels: MailLabel[]; colors: string[] }>('email-label-delete', { id })
      setLabels(result.labels)
      setColors(result.colors)
      if (labelFilter === id) setLabelFilter(null)
      setNotice({ text: 'Label deleted.', error: false })
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

  /** A label put on or taken off one message by hand, on the thread and the list at once. */
  async function assign(messageId: string, labelId: string, on: boolean): Promise<void> {
    const label = labels.find((entry) => entry.id === labelId)
    if (!label) return
    try {
      await api('email-label-assign', { id: messageId, label: labelId, on })
      setThread((current) => current && {
        ...current,
        messages: current.messages.map((mail) => (mail.id === messageId ? withLabel(mail, label, on) : mail)),
      })
      setInbox((current) => current?.map((mail) => (mail.id === messageId ? withLabel(mail, label, on) : mail)) ?? current)
      setNotice({ text: on ? `Added ${label.name}.` : `Removed ${label.name}.`, error: false })
    } catch (error) {
      setNotice({ text: message(error), error: true })
    }
  }

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

  /**
   * A move, applied to the list in place. Reading the inbox again here used to
   * throw away every page after the first and scroll back to the top — the one row
   * that changed is what actually moved. The server's own wording names it.
   */
  async function modify(id: string, op: string): Promise<void> {
    try {
      const result = await api<{ done: string }>('email-modify', { id, op })
      const gone = op === 'archive' || op === 'trash'
      setInbox((current) => current && (gone
        ? current.filter((mail) => mail.id !== id)
        : current.map((mail) => (mail.id === id ? withUnread(mail, op === 'unread') : mail))))
      setThread((current) => current && {
        ...current,
        messages: current.messages.map((mail) => (mail.id === id ? withUnread(mail, op === 'unread') : mail)),
      })
      setNotice({ text: result.done, error: false })
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

  /**
   * The rest of one message's body, past the 4000-character cut the thread draws. The
   * first read replaces the cut text; a text body longer than one chunk appends the
   * next from where it stopped, so a long message is reached a page at a time. An HTML
   * body comes whole, so it is a single replace.
   */
  async function readMore(mail: MailMessage): Promise<void> {
    setReadingMore(mail.id)
    try {
      const body = await api<BodyChunk>('email-body', { id: mail.id, ...(mail.nextOffset ? { offset: mail.nextOffset } : {}) })
      setThread((current) => current && {
        ...current,
        messages: current.messages.map((one) => one.id === mail.id
          ? { ...one, text: mail.nextOffset ? one.text + body.text : body.text, html: body.html, truncated: body.truncated, nextOffset: body.nextOffset }
          : one),
      })
    } catch (error) {
      setNotice({ text: message(error), error: true })
    } finally {
      setReadingMore(null)
    }
  }

  /** Back to the inbox from anywhere in the screen's own path. */
  function toInbox(): void {
    setDraft(null)
    setAssist(null)
    onRoute(null)
  }

  /** Everything narrowing the list at once — the search, the quick filter, the label. */
  function clearNarrowing(): void {
    setSearch('')
    setQuery('')
    setFilter(null)
    setLabelFilter(null)
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
      <button className="button mail-head-summarize" type="button" disabled={busy} onClick={() => void ask('triage', 'Unread summary', {})}><Icon name="spark" size={15} /> Summarize unread</button>
    </div>}
  </div>

  return <main className="settings-workspace mail-workspace" ref={workspace} hidden={!active}>
    <div className="settings-inner mail-inner">
      <div className="settings-panel-stack">
        <section className="settings-section mail-section">
          {head}
          <Notice notice={notice} onDismiss={() => setNotice(null)} />
          {connected && route === null && <div className="mail-controls">
            <label className="mail-search">
              <Icon name="search" size={16} />
              <input type="text" aria-label="Search mail" placeholder="Search mail" value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <fieldset className="mail-filters" aria-label="Filter the inbox">
              <button className={`mail-filter ${filter === null ? 'active' : ''}`} type="button" aria-pressed={filter === null} onClick={() => setFilter(null)}>All</button>
              {status?.filters.map((one) => <button
                className={`mail-filter ${filter === one.id ? 'active' : ''}`}
                type="button"
                key={one.id}
                aria-pressed={filter === one.id}
                onClick={() => setFilter(filter === one.id ? null : one.id)}
              >{one.label}</button>)}
            </fieldset>
          </div>}
          {connected && route === null && <Labels labels={labels} colors={colors} active={labelFilter} sorting={connected.sorting} onFilter={setLabelFilter} onCreate={createLabel} onDelete={removeLabel} />}
          <div className="panel-body">
            {status === null
              ? <p className="list-empty">Reading the connection…</p>
              : connected === null
              ? <NotConnected status={status} />
              : composing
              ? <Compose draft={draft ?? EMPTY_DRAFT} access={access} onChange={setDraft} onSave={() => void saveDraft()} onSend={() => void send()} onDiscard={toInbox} />
              : threadId !== null
              ? thread?.id === threadId
                ? <ThreadView thread={thread} access={access} busy={busy} labels={labels} readingMore={readingMore} onReply={reply} onDraft={() => void draftReply()} onModify={modify} onAsk={ask} onAssign={assign} onReadMore={(mail) => void readMore(mail)} />
                : <p className="list-empty">Reading the thread…</p>
              : <Inbox inbox={inbox} access={access} onOpen={(mail) => onRoute(mail.threadId)} onModify={modify} onMore={loadMore} loading={pageLoading} nextPage={nextPage} narrowed={narrowed} onClear={clearNarrowing} />}
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
  loading,
  nextPage,
  narrowed,
  onClear,
}: {
  inbox: MailSummary[] | null
  access: Access | undefined
  onOpen(summary: MailSummary): void
  onModify(id: string, op: string): Promise<void>
  onMore(): void
  loading: boolean
  nextPage?: string
  narrowed: boolean
  onClear(): void
}) {
  const sentinel = useRef<HTMLDivElement>(null)

  // The list pages itself in as its own end comes into view. `rootMargin` starts the
  // next page a little before the bottom, so the wait lands in the gap rather than at
  // the edge; the fetch is guarded upstream, so a repeated fire is harmless.
  useEffect(() => {
    if (!nextPage) return
    const node = sentinel.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) onMore() },
      { rootMargin: '300px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [nextPage, onMore])

  if (inbox === null) return <p className="list-empty">Reading the inbox…</p>
  if (inbox.length === 0) return <div className="panel-empty">
    <span className="panel-empty-mark"><Icon name="inbox" size={22} /></span>
    <h3>{narrowed ? 'Nothing matches' : 'The inbox is empty'}</h3>
    <p className="panel-empty-copy">
      {narrowed
        ? 'No mail in the inbox matches the search and filters in place.'
        : 'Nothing is in the inbox right now.'}
    </p>
    {narrowed && <button className="button" type="button" onClick={onClear}>Clear search and filters</button>}
  </div>
  return <>
    <div className="mail-list">
      {inbox.map((mail) => (
        <MailRow key={mail.id} mail={mail} access={access} onOpen={onOpen} onModify={onModify} />
      ))}
    </div>
    {nextPage && <div className="mail-more" ref={sentinel}>
      <span className="mail-more-note">{loading ? 'Loading more…' : ''}</span>
    </div>}
  </>
}

/** The width at or under which the row's buttons give way to a sweep — the CSS breakpoint. */
const SWIPE_QUERY = '(max-width: 620px)'
/** How far the finger moves before a drag is a sweep rather than the page scrolling. */
const SWIPE_SLOP = 10
/** How far a row must travel before letting go acts on it. */
const SWIPE_COMMIT = 72
/** How far the row follows the finger before it stops, so a long drag is not carried away. */
const SWIPE_LIMIT = 132

/**
 * One row of the inbox. On a phone the action buttons give their width back to the
 * subject and the row is swept instead: left archives, right toggles read. The buttons
 * stay on a wide screen, where there is room for them.
 *
 * The sweep is offered only where the buttons are hidden and only when the grant allows
 * the write, so a row that cannot be acted on does not move at all. Releasing past the
 * threshold acts; releasing short of it springs back.
 */
function MailRow({
  mail,
  access,
  onOpen,
  onModify,
}: {
  mail: MailSummary
  access: Access | undefined
  onOpen(mail: MailSummary): void
  onModify(id: string, op: string): Promise<void>
}) {
  // Gmail marks unread by carrying `UNREAD`, so one control can do both directions
  // and show which one it will do.
  const unread = mail.labelIds?.includes('UNREAD') ?? false
  const canModify = can(access, 'modify')
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  // A drag that became a sweep must not also open the thread when the finger lifts.
  const swept = useRef(false)
  const gesture = useRef<{ id: number; x: number; y: number; across: boolean | null } | null>(null)

  function down(event: React.PointerEvent<HTMLDivElement>): void {
    swept.current = false
    if (!canModify || !window.matchMedia(SWIPE_QUERY).matches) return
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, across: null }
  }

  function move(event: React.PointerEvent<HTMLDivElement>): void {
    const started = gesture.current
    if (!started || started.id !== event.pointerId) return
    const across = event.clientX - started.x
    const along = event.clientY - started.y
    if (started.across === null) {
      if (Math.hypot(across, along) < SWIPE_SLOP) return
      // The first direction wins: a scroll must not turn into a sweep half-way, and a
      // sweep must not drag the page with it.
      started.across = Math.abs(across) > Math.abs(along)
      if (!started.across) { gesture.current = null; return }
      swept.current = true
      setDragging(true)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setDx(Math.max(-SWIPE_LIMIT, Math.min(SWIPE_LIMIT, across)))
  }

  function release(event: React.PointerEvent<HTMLDivElement>): void {
    const started = gesture.current
    gesture.current = null
    setDragging(false)
    if (started?.across !== true) { setDx(0); return }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (Math.abs(dx) < SWIPE_COMMIT) { setDx(0); return }
    const archive = dx < 0
    setDx(archive ? -SWIPE_LIMIT - 60 : SWIPE_LIMIT + 60)
    // Whatever the call answers, the row goes back where it belongs — unless the list
    // took it away first, which is what a successful archive does.
    void onModify(mail.id, archive ? 'archive' : unread ? 'read' : 'unread').finally(() => setDx(0))
  }

  /** A gesture the browser took back — a system swipe, a lost pointer — never acts. */
  function cancel(): void {
    gesture.current = null
    setDragging(false)
    setDx(0)
  }

  function open(event: React.MouseEvent): void {
    if (swept.current) { swept.current = false; event.preventDefault(); return }
    onOpen(mail)
  }

  return <div className="mail-row">
    {canModify && dx !== 0 && <span className={`mail-row-tray ${dx < 0 ? 'archive' : unread ? 'read' : 'unread'}`} aria-hidden="true">
      <Icon name={dx < 0 ? 'archive' : unread ? 'circle-dot' : 'circle'} size={16} />
      <span>{dx < 0 ? 'Archive' : unread ? 'Mark read' : 'Mark unread'}</span>
    </span>}
    <div
      className="mail-row-track"
      style={{ transform: `translateX(${dx}px)`, ...(dragging ? { transition: 'none' } : {}) }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={release}
      onPointerCancel={cancel}
    >
      <button className="mail-row-open" type="button" onClick={open}>
        <span className="mail-row-from">{displaySender(mail.from)}</span>
        <span className="mail-row-subject">{mail.subject ?? '(no subject)'}</span>
      </button>
      <span className="mail-row-meta">
        {mail.labels && mail.labels.length > 0 && <span className="mail-row-labels">{mail.labels.map((label) => <LabelChip label={label} key={label.id} />)}</span>}
        <span className="mail-row-when">{mailDate(mail.date)}</span>
      </span>
    </div>
    <span className="mail-row-actions">
      <button className="mail-row-action" type="button" title={canModify ? 'Archive' : 'Archive needs “Tidy up” access'} aria-label="Archive" disabled={!canModify} onClick={() => void onModify(mail.id, 'archive')}><Icon name="archive" size={15} /></button>
      <button className="mail-row-action" type="button" title={canModify ? (unread ? 'Mark read' : 'Mark unread') : 'Needs “Tidy up” access'} aria-label={unread ? 'Mark read' : 'Mark unread'} disabled={!canModify} onClick={() => void onModify(mail.id, unread ? 'read' : 'unread')}><Icon name={unread ? 'circle-dot' : 'circle'} size={15} /></button>
    </span>
  </div>
}

/** One label as the list draws it: a filled pill in its colour. */
function LabelChip({ label }: { label: MailLabel }) {
  return <span className="label-chip" data-color={label.color}>{label.name}</span>
}

/**
 * The label bar over the inbox: Milo's own labels, a filter by each, and the way to
 * add and drop one. Local to Milo — none of it touches Gmail — so it needs no grant
 * and is offered at every access level.
 */
function Labels({
  labels,
  colors,
  active,
  sorting,
  onFilter,
  onCreate,
  onDelete,
}: {
  labels: MailLabel[]
  colors: string[]
  active: string | null
  sorting: boolean
  onFilter(id: string | null): void
  onCreate(name: string, color: string): void
  onDelete(id: string): void
}) {
  const [draft, setDraft] = useState<{ name: string; color: string } | null>(null)
  return <div className="mail-labels">
    {!sorting && <span className="mail-labels-note">Milo has no classifier set up, so it cannot sort mail — your own labels still work.</span>}
    <div className="mail-label-list">
      {labels.length === 0
        ? <span className="mail-labels-empty">{sorting ? 'No labels yet. Milo sorts the inbox as mail arrives.' : 'No labels yet.'}</span>
        : labels.map((label) => <span className={`label-chip label-chip-filter ${active === label.id ? 'active' : ''}`} data-color={label.color} key={label.id}>
            <button className="label-chip-name" type="button" onClick={() => onFilter(active === label.id ? null : label.id)}>{label.name}</button>
            <button className="label-chip-remove" type="button" title={`Delete ${label.name}`} aria-label={`Delete the label ${label.name}`} onClick={() => onDelete(label.id)}><Icon name="x" size={12} /></button>
          </span>)}
      {active !== null && <button className="mail-label-clear" type="button" onClick={() => onFilter(null)}>Clear filter</button>}
    </div>
    {draft
      ? <form className="mail-label-form" onSubmit={(event) => { event.preventDefault(); const name = draft.name.trim(); if (name) { onCreate(name, draft.color); setDraft(null) } }}>
          <input className="mail-label-input" placeholder="Label name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          <span className="label-swatches">
            {colors.map((color) => <button className={`label-swatch ${draft.color === color ? 'active' : ''}`} data-color={color} type="button" key={color} title={color} aria-label={color} onClick={() => setDraft({ ...draft, color })} />)}
          </span>
          <button className="button primary" type="submit" disabled={!draft.name.trim()}>Add</button>
          <button className="button" type="button" onClick={() => setDraft(null)}>Cancel</button>
        </form>
      : <button className="label-chip label-chip-new" type="button" onClick={() => setDraft({ name: '', color: colors[0] ?? 'sage' })}><Icon name="plus" size={13} /> New label</button>}
  </div>
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
  labels,
  readingMore,
  onReply,
  onDraft,
  onModify,
  onAsk,
  onAssign,
  onReadMore,
}: {
  thread: MailThread
  access: Access | undefined
  busy: boolean
  labels: MailLabel[]
  readingMore: string | null
  onReply(message: MailMessage): void
  onDraft(): void
  onModify(id: string, op: string): void
  onAsk(mode: 'summarize', title: string, body: Record<string, unknown>): void
  onAssign(messageId: string, labelId: string, on: boolean): void
  onReadMore(message: MailMessage): void
}) {
  const [picking, setPicking] = useState<string | null>(null)
  const last = thread.messages[thread.messages.length - 1]
  return <>
    <div className="mail-thread-actions">
      <button className="button" type="button" disabled={busy} onClick={() => onAsk('summarize', 'Thread summary', { threadId: thread.id })}><Icon name="spark" size={15} /> Summarize</button>
      <button className="button" type="button" disabled={busy || !can(access, 'compose')} title={can(access, 'compose') ? undefined : 'Drafting needs “Write drafts” access'} onClick={onDraft}><Icon name="reply" size={15} /> Draft with Milo</button>
      <button className="button" type="button" disabled={!can(access, 'modify')} title={can(access, 'modify') ? undefined : 'Needs “Tidy up” access'} onClick={() => last && onModify(last.id, 'archive')}><Icon name="archive" size={15} /> Archive</button>
      <button className="button" type="button" disabled={!can(access, 'modify')} title={can(access, 'modify') ? undefined : 'Needs “Tidy up” access'} onClick={() => last && onModify(last.id, 'unread')}>Mark unread</button>
      <button className="button" type="button" disabled={!can(access, 'modify')} title={can(access, 'modify') ? undefined : 'Needs “Tidy up” access'} onClick={() => last && onModify(last.id, 'trash')}><Icon name="trash" size={15} /> Delete</button>
      <button className="button primary" type="button" disabled={!can(access, 'compose') || !last} title={can(access, 'compose') ? undefined : 'Replies need “Write drafts” access'} onClick={() => last && onReply(last)}>Reply</button>
    </div>
    <div className="mail-thread">
      {thread.messages.map((mail) => <article className="mail-message" key={mail.id}>
        <div className="mail-message-head">
          <strong className="mail-sender">{displaySender(mail.from)}</strong>
          <span className="mail-message-labels">
            {(mail.labels ?? []).map((label) => <LabelChip label={label} key={label.id} />)}
            <button className="mail-label-add" type="button" title="Label this message" aria-label="Label this message" onClick={() => setPicking(picking === mail.id ? null : mail.id)}><Icon name={picking === mail.id ? 'x' : 'plus'} size={12} /></button>
          </span>
          <span className="mail-when">{mailDate(mail.date)}</span>
        </div>
        {picking === mail.id && <div className="mail-label-picker">
          {labels.length === 0
            ? <span className="mail-labels-empty">No labels yet — add one above, or let Milo make them as it sorts.</span>
            : labels.map((label) => {
                const assigned = (mail.labels ?? []).some((entry) => entry.id === label.id)
                return <button className={`mail-label-pick ${assigned ? 'active' : ''}`} data-color={label.color} type="button" key={label.id} aria-pressed={assigned} onClick={() => onAssign(mail.id, label.id, !assigned)}>
                  <Icon name={assigned ? 'check' : 'plus'} size={12} /><span>{label.name}</span>
                </button>
              })}
          {labels.length > 0 && <button className="mail-label-done" type="button" onClick={() => setPicking(null)}>Done</button>}
        </div>}
        <div className="mail-message-subject">{mail.subject ?? '(no subject)'}</div>
        <MailBody message={mail} />
        {mail.truncated && <p className="mail-message-note">
          The body was cut.{' '}
          <button className="button" type="button" disabled={readingMore === mail.id} onClick={() => onReadMore(mail)}>
            {readingMore === mail.id ? 'Reading…' : 'Read the rest'}
          </button>
        </p>}
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
