# Google (Gmail & Drive)

Off until it is turned on, and connected to an OAuth app of **your own** — Milo ships no Google
identity. `milo google connect` walks it: an OAuth client of the type **Desktop app**, from a Cloud
project of yours with the Gmail and Drive APIs enabled, then the browser consent, which has to happen
at the machine that runs Milo. It **asks how much access to allow** — `none` (read), `modify` (archive,
mark read), `compose` (drafts) or `send` — and there is no default: a run with no terminal to ask on
stops and lists the levels rather than picking one. Google grants access one level at a time and
cannot widen it later, so more access means reconnecting. `milo google status` says what is connected
and at which level, and `milo google forget` drops the grant while keeping the app identity. The same
flow is `milo setup` → **Tools** → **Google**, and Settings → Google in the web UI.

```yaml
google:
  enabled: true
```

Turning it on registers four read-only tools — `gmail_search` / `gmail_read` and `drive_search` /
`drive_read` — plus two that act, as far as the grant allows. `gmail_modify` archives a message, marks
it read or unread, or moves it to the bin — Gmail's `trash`, recoverable for thirty days, never the
permanent delete. `mail_labels` lists and edits Milo's own mail labels, which live in
`~/.milo/labels.json`, are never written back to Gmail, and answer which messages carry one now. Email
writes are a shared core capability: the web **Email** screen and the agent reach them through the same
functions. The agent's `gmail_modify` asks before acting and needs the `modify` grant, and a routine
that acts on mail with nobody there has to name it in `allow` — which is how "from now on, bin
everything with label X" is made. Drive stays read-only. The scopes follow the level: `gmail.readonly` +
`drive.readonly` are the base, and `gmail.modify`, `gmail.compose` and `gmail.send` are added as the
level rises, never before. A Google Doc or Sheet comes back as exported text; a file Milo cannot read
as text says so by type instead of pretending. `milo google status` names the tools a connection
actually bought, taken from the same factories that answer, so the line cannot drift from what is
registered.
