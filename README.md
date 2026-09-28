<div align="center">
  <img src="assets/milo.jpeg" alt="Milo" width="190">
</div>

# Milo

[![CI](https://github.com/postEntropy/milo/actions/workflows/ci.yml/badge.svg)](https://github.com/postEntropy/milo/actions/workflows/ci.yml)

A multi-surface agent — one transport-agnostic **core** with pluggable **gateways** (CLI, Telegram,
Discord, web), pluggable **LLM providers**, a pluggable **memory** layer and durable **sessions**.
Hand-rolled LLM layer (no provider SDKs), built for a fast boot and immediate token streaming.

```
GATEWAYS   CLI (Ink)      Telegram (grammY)      Discord (discord.js)      Web (React)
              └────────────────────┴───────────────────────┴──────────────────┘
CORE       AgentRuntime → Session → AgentLoop   +  Tools · Memory · Providers · Config · Routines
PROVIDERS  Command Code Provider API · OpenRouter · OpenAI · Anthropic · Ollama · custom
```

The core never knows about Ink, Telegram, Discord or a browser. It hands each gateway a stream of
normalized `AgentEvent`s; gateways translate user input in and events out.

## Requirements

- Node.js >= 22.13 (developed on 26). The floor is where `node:sqlite` stops being
  behind a flag, because the memory store runs on it and Node 20 has no such module at all.
- An API key for one provider (or a local Ollama), for conversational use

## Install & run

```bash
npm install
npm run dev            # start the interactive CLI chat
npm run dev -- --model deepseek/deepseek-v4-flash   # override the model for one session
```

On the first run, an onboarding wizard asks for a provider, API key, and model, and saves them to
`~/.milo/`.

The composer stays live while a turn is running — that is exactly when a correction is worth typing.
`Enter` **queues** the message behind the turn in flight and runs it as its own turn once that one
ends; `Ctrl+Enter` **steers** it instead, into the running turn, at the next step boundary — the one
point where the transcript is not halfway through a tool call. A steer is a correction, so the turn
carries on with it rather than starting a second one, and a message typed too late to be taken up
becomes the next turn rather than being dropped. A terminal only reports the Ctrl modifier on Enter
when it speaks the kitty keyboard protocol, which Milo switches on outright — asking the terminal
whether it does was tried and reverted: Ink sends that query before the tty is in raw mode, so the
reply cannot be read, and it later arrives on stdin as if it had been typed. A terminal that does not
know the protocol ignores the switch, so `Alt+Enter` steers there — that one is distinguishable
everywhere.

`Ctrl+C` stops the turn in flight and drops whatever was queued behind it, saying how many. The
partial answer stays in the transcript and the turn is reported as *stopped*, not as an error,
because a stop is the user's own doing. Pressed with nothing running, it exits.

`↑` walks back through what was sent — each press one line further back — and `↓` comes forward again,
handing back whatever was being typed when the walk started. The list is written to
`~/.milo/input-history.json`, so a command from yesterday is still one arrow away; it is the input
line history, and a different thing from the turn log the model can search (`## History`).

`/new`, `/resume`, `/clear`, `/model` and `/setup` are refused while a turn is running: they rebind
the session, empty the transcript it is writing into, or take over the screen its output is going
to. Stop it first with `Ctrl+C`.

A turn that takes a second or more to produce anything leaves a line saying how long it took to get
going: `✻ Thought for 8.2s`, or `✻ Thought for 12s (4.2s compacting)` when a summary call ran first.
It is measured from the question to the model's first visible output — text or a tool call — and
reasoning deltas deliberately do not count, since they *are* the thinking. Without it, "that was
slow" has no answer beyond a guess; with it, the wait says what it was spent on.

## Configuration

- `~/.milo/config.yml` — provider, model, `maxTokens`, reasoning effort, memory settings, session
  settings, display, permissions, browser, the web UI's address and enabled gateways. YAML rather than
  JSON for the one thing JSON cannot express: a comment. Every surface rewrites this file (`/mode`,
  `/tools`, `/effort`, `/model`, `milo setup`, the browser's Settings screen), so the help is stamped on
  by the code that writes it (`src/core/config/comments.ts`), and a line you add yourself survives every
  write that does not touch the key it sits above. (`src/core/skills/index.ts` reached the opposite
  conclusion for a skill's frontmatter, and rightly: two scalars are not worth a parser. A config is.)
- `~/.milo/auth.json` — API keys and bot tokens (written `0600`).
- `~/.milo/input-history.json` — what was typed at the CLI's prompt, for `↑`/`↓`.
- `~/.milo/sessions/` — one JSON file per session, plus one binding file per address and one recap
  per session that has been left behind (see below).
- `~/.milo/memory/` — the memory store: `memory.db`, one SQLite file of facts for the whole install
  (see [Memory](#memory)). An install that predates it still has the `*.json` files here: they are read
  once, when the database is first created, and left alone after that.
- `~/.milo/history/` — the log: one JSONL per day, what was asked, answered and run. `turns.db` sits
  beside them: an index of what you typed, derived from those files and rebuildable from them (see
  [Memory](#memory)).
- `~/.milo/skills/` — one `<name>/SKILL.md` per skill (see [Skills](#skills)).
- `~/.milo/browser/` — the browser's own profile (`profile/`), a downloaded Chrome (`chrome/`) when
  one was, and profiles copied out of a browser you use (`profiles/`). Not the browser you use (see
  [Browser](#browser)).
- `~/.milo/exports/` — conversations written out by `/export`, one file each (`0600`).

A corrupt `config.yml` is reported at startup rather than swallowed, but the settings a running
conversation changes (`/mode`, `/tools`, `/thinking`) read it defensively: a file that cannot be
parsed leaves the current values alone instead of failing the turn. A write is an edit rather than a
rewrite — the file is read as a document, the keys whose values moved are the only ones replaced, and
everything else stays as it was, comments and order included — so changing a setting never costs you
the notes you put beside the others.

Environment variables override stored secrets: `COMMANDCODE_API_KEY`, `OPENROUTER_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `MILO_WEB_TOKEN`.
Set `MILO_HOME` to relocate `~/.milo`; set `MILO_DEBUG=1` for debug logs (memory `remember`/`recall`
calls, skipped stream chunks).

### Providers

| Preset | Endpoint | Wire |
| --- | --- | --- |
| `commandcode` | `https://api.commandcode.ai/provider/v1` | auto (Claude → `/messages`, others → `/chat/completions`) |
| `openrouter` | `https://openrouter.ai/api/v1` | OpenAI |
| `openai` | `https://api.openai.com/v1` | OpenAI |
| `anthropic` | `https://api.anthropic.com/v1` | Anthropic |
| `ollama` | `http://localhost:11434/v1` | OpenAI (no key) |

The Command Code Provider API needs a plan above Go (GOAT/Pro/Max/Team or the Provider plan), and
uses the same API key as the CLI (Command Code's Studio → API keys — not this project's Settings).

## Gateways

The CLI is always available. The bot gateways run as a daemon:

```bash
milo setup                 # Gateways section toggles them and stores the tokens
# or edit ~/.milo/config.yml:
gateways:
  telegram: { enabled: true }
  discord: { enabled: true }
```

```bash
export TELEGRAM_BOT_TOKEN=...
export DISCORD_BOT_TOKEN=...
npm run serve
```

Each conversation maps to its own session (`telegram:<chatId>`, `discord:<channelId>`), while what
Milo remembers is one store for the whole install: what you told it in the terminal is there on
Telegram. Replies stream by editing one message; tool activity becomes one line per
call — a **quote box** with the tool's icon, its name and the one value worth showing, whether that
is a search query or a file path. Every tool line opens with an emoji, never a
typographic glyph (these are read in chat clients), and the tool **name is bold** so it does not read
as the first word of its own arguments; a tool that fails adds `❌ <name> failed` as another line of
the same shape.

A **shell command is the exception**: it gets a fenced `shell` block of its own, under the same label
line, because a command is meant to be read and copied and neither is served by a 120-character gist.
The block was here before and was taken away for two reasons worth keeping, so both are answered
rather than argued away: the label sits *outside* the fence, so the name is still emphasised, and the
command goes in **whole** — a block whose contents were cut off is a block that lies about what it is
for. Being a block of its own, it ends the run of tool lines; the next call opens a quote of its own.

```
⚡ **shell_command**

```shell
cd /opt/app && npm test -- --runInBand
```
```

**Why a run of tool lines shares one quote.** A tool call is one burst of work, and the model's own
activity reads better together. A quote is a single paragraph, though, and a newline inside a
paragraph is a *soft break* — so the lines inside the shared quote are separated by a **hard break**
(two spaces before the newline), which is what keeps two calls from reflowing into one sentence
("… preços web_search OpenAI new model release …"). A thought (`💭 …`) is quoted too, but never joins
that run: the thought is the model talking, the arguments are data, and they are not the same thing.
The terminal draws the same lines — same icons, same one-value gist, and no box of its own for the
shell.

On Telegram the answer goes out as a **rich message** (Bot API 10.1+), so Markdown renders —
headings, lists, tables, code blocks — falling back to plain text if the API refuses it.
For Discord, enable the **Message Content** privileged intent in the Developer Portal.

Tool confirmations arrive as **inline buttons** (Telegram) or **buttons** (Discord) — the turn
waits for the press and fails closed after five minutes.

### Who can talk to the bot

By default a bot answers anyone who finds it. Give it an `allowlist` to close that down:

```yaml
gateways:
  telegram:
    enabled: true
    allowlist: ["123456789"]
```

An entry matches either the sender's **user id** or the **conversation id** (chat, channel or
guild), so you can allow one person or a whole room. An empty list means anyone; a non-empty list
fails closed for everyone else, and a blocked sender is told their own id so you can add it.
`milo setup` → Gateways walks through token → access → enable. The allowlist is read when
`milo serve` starts, so restart it after changing it.

Commands typed in the chat: `/help`, `/new`, `/sessions`, `/resume`, `/stats`, `/compact`, `/export`,
`/skills`,
`/mode ask|auto|yolo`, `/yolo`, `/tools full|name|off`, `/thinking on|off`, `/effort low|medium|high`,
`/clear`, `/status`. A mode change from a chat is written to `config.yml` like any other,
so it survives a restart of `milo serve`; sessions are written to `~/.milo/sessions/` and survive it
too. Provider and key changes happen in `milo setup` on the terminal side.

Three of them are about the turn rather than about the session, so they are answered **outside** the
queue — a `/stop` that waited for the turn it is meant to stop would arrive after it:

| Command | What it does |
| --- | --- |
| `/stop` | Aborts the turn running now, and drops anything queued behind it. A message sent after that runs normally, so this is "that was not what I wanted" rather than a kill switch. |
| `/steer <text>` | Hands the text to the turn running now; it is read at its next step. Same thing a plain message does — the explicit form, for when you want to be sure. |
| `/queue <text>` | Says it as its own turn, after the one running now. The one way to say something *after* the answer instead of into it. |

`/compact` is a session command, so it does queue like one: it folds the oldest turns into the
summary on demand, keeping the last `keepTurns` turns verbatim — the manual fold keeps the floor,
where the automatic pass will recuse past it to fit — and says how many turns it folded and what they
held, or that the fold still leaves the request over its ceiling, or that there was nothing old
enough to fold, which is the common answer and not the same one as a compaction that worked. If the
summary call fails the turns go anyway (a request that fits beats one the provider rejects) and the
reply says so rather than pretending a summary exists.

The terminal has the same four commands, because they are the names for what it already does with
modifier keys: `/stop` is Ctrl+C, `/steer` is Ctrl+Enter, `/queue` is Enter-during-a-turn — same
rules, same wording, and `/stop` throws away exactly what Ctrl+C throws away, down to the count it
reports when the turn is over. What is shared is the vocabulary and the decision of *where a text
goes* (`src/gateways/commands.ts`); each surface binds it to its own machinery — a `TurnQueue` in the
bots, refs in the CLI — so the two cannot drift into different meanings for the same word.

`/stop` is immediate and asks nothing: a control command is not a tool, so no confirmation gate
applies to it in any mode, and it is answered **outside** the queue. It also takes a pending
permission prompt down with it — the wait resolves as a **denial**, because the alternative is a turn
parked on a button for five minutes with a ✅ still able to allow the tool the stop was meant to
prevent.

Both bots are thin shells over one transport-agnostic runner (`src/gateways/runner.ts`) plus a
`ChatSurface` interface, so the turn logic — streaming, tool lines, permission routing, truncation
— is shared and unit-tested against a fake surface. The library glue (grammY / discord.js calls)
is the part that only a real token can exercise.

A gateway must hand each turn to its `TurnQueue` instead of awaiting it in the update handler. A
turn blocks until the user answers a permission prompt, and Telegram's simple long polling handles
updates one at a time (`handleUpdates` awaits each one), so awaiting a turn there would leave the
button press queued behind the very turn waiting for it — a deadlock that ends in a timeout and a
denied tool. The queue also stops two turns from mutating the same session at once.

A message sent while a turn is **running** is handed to that turn instead of starting a second one:
it is taken up at the next step boundary, after the tool call in flight, so a correction reaches the
model without a second turn racing the first over the same session. A chat surface has no
`Ctrl+Enter`, so this is what a bot does with both — the CLI asks, because there it can; `/steer` and
`/queue` are how a chat says which of the two it means. Commands are never steered: `/new` is not
something to say to the model, so it waits its turn like a message would. A message that lands in the
gap between two turns becomes a turn of its own rather than being dropped, and so does a correction
the model never got to see — except after a `/stop`, where the stop was the answer to everything sent
by then.

The queue is also what can stop a turn, which is why it owns the abort handle: an `AbortController`
per conversation, aborted by `/stop`, with the signal threaded through `runTurn` → `session.send` →
provider and tools, and its epoch bumped so the turns queued before the stop are skipped when their
turn comes. A stop is not a failure: `session.send` turns a cancelled stream into an `aborted` event,
so the message ends with `🛑 stopped` instead of a red `AbortError`.

## Web

The fourth surface is a browser chat, with the same core, sessions and memory behind it. It is
served by `milo serve`, so a daemon that was already keeping the bots up also opens the URL it
prints:

```
Milo serving: telegram, web
Milo web · http://127.0.0.1:7717/?t=<token>
```

The token in that URL is the whole of the authorization — it is what the page sends back on every
request, and it is why the address is not meant to be shared. Loopback is the default for the same
reason. It is **minted per run unless one is stored**, and that is the whole of why a URL printed
yesterday is a 401 today: a token meant to outlive the process goes in `auth.json` →
`gateways.web` — the `0600` slot the bot tokens already use, rather than the readable
`config.yml` — or arrives as `MILO_WEB_TOKEN`, which wins over the stored one. With neither, each
run mints its own and prints it, which is the old behaviour and the default. It is deliberately not
one of the fields `milo setup` → **Web** edits: that screen is where the address lives, and the
token is a secret, so it is set the way the other secrets are.

```bash
milo serve                 # the bots and the web UI
milo serve --no-web        # the bots alone
milo serve --web-port 8080 # one run on another port
milo web                   # the web UI alone, no bots, opening the browser
```

`milo web` is the standalone form: it starts nothing else and opens the browser at the URL, which
is the useful shape while setting the UI up. It takes `--host`, `--port` and `--no-open`.

```yaml
web:
  enabled: true
  host: 127.0.0.1
  port: 7717
```

Where it binds comes from that section, and a flag wins over it for one run. `milo setup` → **Web**
edits it in the terminal, and the Settings screen in the browser has the same section. `enabled:
false` is `--no-web` written down. **Anything but loopback is reachable from the network** — the page
still requires the token, but the token is then the only thing in the way, so a host other than
`127.0.0.1`/`localhost` is a decision to make deliberately. Binding to `0.0.0.0` accepts whatever
name the request came in on; any other address is pinned to the name it was given. Bound to every
interface there is no name to print, so the URL is loopback and the machine's own addresses are
listed under it — `0.0.0.0` is what you bind, not a name another device can open, and a URL built
from it opens nothing on the phone you meant to reach it from. A bind that fails says which address
it tried and what to change (`port 7717 is already in use — another process holds it`), because a
surface that is not up must not be read as one that is.

The chat itself is the terminal's turn model with a real browser behind it: messages stream in,
reasoning folds under the question it belongs to, tool lines appear as they run, a confirmation is
a card with Allow and Deny, and `Enter` queues while `Ctrl+Enter` steers. Typing `/` opens the
command palette, so the slash commands are discoverable rather than memorized. Export and Clear sit
in the top bar, and sessions can be searched, resumed and deleted.

**Settings** (the sidebar's last row) is `milo setup` in the browser — provider and model, API keys,
memory (including the notes themselves, and turning embeddings on), routines, gateways, tools and
the browser, the permission policy, display, skills and sessions. The long setup jobs run here with
their output streamed into a panel: downloading a Chrome for Testing build, copying a profile out of
another browser, and provisioning the local embedding engine (the ~1.9 GB one). `milo serve` starts
it by default and it can be turned off here or in `milo setup` → **Web**, which is where its address
and port live.

A routine can be delivered to a web chat: `gateway: "web"` with the conversation id from the
browser's address, and the answer is written into that conversation's session, so it is still there
when the tab is next opened.

Two things are worth knowing before pointing a browser at it:

- **The frontend has to be built.** `npm run build:web` compiles `web/` into `web/dist`, which is
  what the server serves; without it the page is a 503 and the boot line says so.
- **The page may only come from a name the server answers to.** A request whose `Origin` names
  something else is refused, which is what keeps another site from reaching the local install
  through a logged-in browser.

A prompt Milo runs on a timer and delivers to a chat, with nobody there when it fires. "Every weekday
at 8, look at the repo and tell me what moved" is a routine: it opens its own conversation, runs the
prompt, and posts the answer to the chat you named.

Made two ways, one list. In chat you say it in your own words — *"every two hours, check the deploy"*,
*"every weekday at 8, look at the repo and tell me what moved"* — and the `routine` tool turns the
sentence into one, defaulting the destination to the chat you said it in. Or on the terminal:

```bash
milo routines add "look at the repo and tell me what moved" --name "daily briefing" \
  --at 08:00 --days mon-fri --gateway telegram --to 123456789
milo routines add "deploy status" --every 6h --gateway discord --to 987654321
milo routines list
milo routines disable calm-otter-7
milo routines run calm-otter-7        # fire it now, printing the answer
milo routines remove calm-otter-7
```

Every routine has a **name**: the `--name` you give it, or the first words of the prompt when you give
none (`look at the repo and tell me what moved…`). The name is what `milo routines list` leads with,
what the assistant says back when it makes one, and what signs the message in the chat — `daily
briefing` on its own line, then the answer — so a room with several of them can tell which one just
spoke. The id (`calm-otter-7`) is only for the commands.

The list is `~/.milo/routines.json`: one JSON array, readable and editable by hand, and reread on every
tick — so a routine the assistant created mid-chat is picked up without restarting the daemon, and one
you delete is dropped just as quietly. It holds up to 50.

A routine's time is one of two shapes: an interval (`every 30m`, `every 2h`) counted from the last run,
or a wall-clock time (`08:00`, `8h`) with optional days (`mon-fri`, `mon,wed,fri`, `1-5`). Times are
**local**, and one with no days runs every day. Day names are read in English or Portuguese, and
written back in English. There is no five-field cron yet — day-of-month and `*/15` are not expressible.

Three things are worth knowing before you rely on one:

- **Only `milo serve` fires them.** The daemon is the process that stays up; a routine does not run
  while it is down, and a time it slept through is **skipped, not caught up** — you get the next one,
  once, rather than a burst of the mornings you missed.
- **Permission is decided when the routine is made, not when it fires.** Reading needs nothing.
  Anything that writes, runs or sends a file is a standing grant it carries (`--allow
  shell_command,send_file`, or what the assistant proposes in chat), and it is confirmed where there
  is someone to confirm it — at creation. At fire time the grant is what stands in for a person: a
  granted tool runs, anything else keeps the policy's answer, which with nobody to ask is a refusal. An
  explicit deny still denies, and the rules that bar a destructive command or a protected path still
  apply — granting a tool is not granting every use of it. In `yolo` mode nothing is asked and the
  routine simply runs in yolo.
- **Each run is a new conversation.** A routine does not carry yesterday's context into today's run —
  it is a prompt on a timer, not a thread. The runs are sessions like any other (`routine:<id>`), named
  after the routine, so they show up in `/sessions` and are searchable with `search_history`.

The answer is posted at the target when the run finishes, split across messages if it is long. A
routine can also deliver **files**: its `send_file` tool posts a file from the machine to the same
chat, as a picture when it is an image and a document otherwise. So *"every morning, screenshot the
screen and send it"* is a routine — `shell_command` runs `grim` (Wayland) or `scrot` (X11), then
`send_file` hands over the PNG. On the terminal that is `--allow shell_command,send_file`; a file
reaches the chat with no answer to lead it, so a run that says nothing but delivers a picture still
speaks. A failure is posted too (`⚠ routine "…" failed: …`), so one that breaks reaches you instead
of going quiet. If a run is still going when its next time comes, that occurrence is skipped rather than
stacked, and `milo routines list` shows what the last one did. A routine cannot create more routines —
the `routine` tool is absent inside a routine's own run.

## Tools

| Tool | Read-only | Notes |
| --- | --- | --- |
| `read_file` | yes | Line-numbered file contents; a long file comes back in pages. |
| `list_dir` | yes | One directory, not recursive. |
| `glob` | yes | Files matching a pattern, most recently modified first. |
| `grep` | yes | Regex over file contents, returning `path:line: text`. |
| `fetch_url` | yes | One http(s) URL, served back as text; a long page comes back in pages. |
| `write_file` | no | Creates or replaces a file; asks for confirmation. |
| `edit_file` | no | Exact string replacement; asks for confirmation. |
| `remember` | — | Saves a durable fact; only touches Milo's own memory, so it never asks. |
| `recall` | yes | Which past session a question is about, and what it was about. |
| `search_history` | yes | Term search over Milo's own past turns, reasoning and tool calls included. |
| `routine` | — | Runs a prompt on a timer and delivers it to a chat. Asks only when the routine carries a standing grant; absent inside a routine's own run. |
| `send_file` | no | Sends a file to the chat this turn delivers to — a routine's target — as a picture when it is an image. Asks; needs a grant to run unattended. Unavailable in a chat someone is sitting at. |
| `web_search` | yes | Registered only when a search provider is configured. |
| `read_skill` | yes | Loads a skill's instructions on demand; registered only when a skill is installed. |
| `task` | — | Runs a subtask in its own context; only the report comes back. Only on request; never asks itself. |
| `browser_open` | yes | Opens an http(s) URL and returns the page as numbered elements. Only when the browser is on. |
| `browser_snapshot` | yes | The current page again: its elements, its text, or a picture of the viewport for the model to look at. |
| `browser_screenshot` | no | A picture of the viewport written to a file, so the person can open it. Asks, because it writes. |
| `browser_act` | no | Click, double-click, type, press, hover, scroll, choose, upload — and the page afterwards, in the same call. |
| `shell_command` | no | Runs with `/bin/sh`; asks for confirmation first. |

Read-only tools never ask for confirmation, so exploring is free: `list_dir`, `glob` and `grep`
replace the `ls`, `find` and `rg` calls that would otherwise go through `shell_command` and its
prompt. `glob` and `grep` skip build output and dependency directories (`node_modules`, `dist`,
`build`, `target`, `.venv`, …) so a search answers about your code, not about `node_modules`; pass
one of them as `path` to search inside it. `grep` skips binary or oversized files and says how many
it skipped, and both tools report when they truncated their own results.

`read_file` cuts **between lines** and names what is left (`… 812 more line(s); continue with
offset=413`), so a big file is paged through instead of being silently halved; a single line longer
than the whole budget — a minified bundle — is clipped and says so. Reading past the end says the
file has that many lines, rather than reporting it as empty.

`fetch_url` reads one URL and hands the page back as text: scripts, styles and tags are dropped,
block elements become line breaks, and entities are decoded. A page longer than the budget (40k
characters) is cut and names the offset that continues, the same way `read_file` pages a file — and
the window after it is served from the copy just read, so paging a document costs one download
instead of one per page. A fresh read (`offset` unset) always goes to the network, because "what
does this URL say now?" deserves a fresh answer.

The body is read in chunks under a 5 MB ceiling: a response that lies about its size, or grows past
it, is cut off and says so — and the rest of the download is dropped rather than drained. A size
the server declares over that ceiling is refused before the body is fetched at all. Anything that
is not text — an image, a PDF — is refused with the content type it saw. Like a search result, what
comes back is untrusted data: the tool description tells the model to read it, not to obey it.

`write_file` and `edit_file` write through a temporary file and a rename, and copy the target's
permissions over first: a crash mid-write leaves the previous contents, not half a function, and an
edit does not quietly drop an executable bit.

`edit_file` replaces an exact string and **fails rather than guess**: a string that is absent, or
that appears more than once without `replace_all`, is an error instead of an edit in the wrong
place. It returns where it landed (`at line 12`), not the file, so a long file does not come back
into the context. A leading `~` in any path is expanded, in every tool.

`shell_command` keeps the **head and the tail** of a long output, not just the head: stderr comes
last, so trimming only the end is how an error message gets thrown away.

Anything with side effects goes through the permission policy in the core:

```yaml
permissions:
  mode: ask
  allow: [shell_command]
  deny: []
  jevThreshold: 0.35
  jevTimeoutMs: 1500
```

| Mode | Behavior |
| --- | --- |
| `ask` (default) | Read-only is allowed, `deny` blocks, everything else asks. |
| `auto` | Deterministic rules block the catastrophic cases first; the grey zone is reviewed by `typesafe/jev` — below `jevThreshold` it runs, above it asks. Fails closed on reviewer errors and timeouts. |
| `yolo` | Everything runs, no prompts. |

`deny` beats everything except `yolo`. Read-only tools never ask, and neither does a tool whose only
side effect is on Milo's own state (`remember`). On a surface that cannot ask (a bot gateway with no
confirmation UI yet) an `ask` decision **fails closed**.

The deterministic rules cover two shapes, and only in `auto`: a shell command that is catastrophic
(`rm -rf /`, `mkfs`, a `curl … | sh`), and anything writing into a path that is never a legitimate
target — a system directory (`/etc`, `/usr`, `/bin`, `/boot`, …, including one reached by
traversal) or a credential store (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`). Both are refused
outright rather than reviewed. The second one follows the *path*, not the tool: `write_file` into
`~/.ssh/authorized_keys` and `rm -rf ~/.ssh` or `echo key > ~/.ssh/authorized_keys` through the
shell are refused the same way, because it is the same act. It reads the command as text —
redirections, and the commands that take a path to write (`rm`, `mv`, `cp`, `tee`, `truncate`,
`sed -i`, `dd of=`, `chmod`, `curl -o`) — which makes it a backstop, not a sandbox; reading a system
file stays fine, and `> /dev/null` is not a write. Everything else with side effects — including an
ordinary file write — goes to the reviewer. Note that the rules are an `auto`-only backstop: in
`ask` a write to `/etc` is a prompt the user answers, not a refusal.

**What the prompt shows.** A confirmation is only worth asking if it says what it is asking about,
so a write shows the target *and* the content — `- old` / `+ new` for an edit — and a command shows
the directory it will run in (`cd /etc && …`) when the call sets one. Long content is trimmed to a
screenful. An `allow` entry is checked before the rules, so `allow: ["shell_command"]` is a blanket
"never ask about this tool" and turns the backstop off for it.

Switch at runtime with `/mode ask|auto|yolo` or `/yolo` — from the terminal or from a bot. The mode
is **saved** whenever a command changes it, and it is one value for every surface: a `/mode` typed in
Telegram also applies to the next terminal session. `milo --mode`/`--yolo` are per-session overrides
and write nothing, so a one-off `--yolo` does not stick. The header shows the active mode whenever it
is not `ask`.

A bot refuses `/mode` and `/yolo` unless exactly one id is allowed. With several people — or with an
open bot, where anyone who finds it can talk — one of them must not be able to turn off confirmation
for the others; the reply says so and points at `milo setup`. `/tools` and `/thinking` are locked by
the same rule, since the display is one value for the whole install too.

The `auto` reviewer only exists where the decision model does — a Command Code provider. Anywhere
else, `auto` degrades to `ask`.

### Browser

A real Chromium over the DevTools protocol, driven through the page's own DOM. Not a picture of a
browser and not a desktop: no screen session is involved, and the ordinary path pays for no pixels
at all.

It is **off until it is turned on** — `milo setup` → **Tools** → **Browser**, or
`"browser": { "enabled": true }` in the config. Off means the three tools are not in the catalog at
all, so the model never sees a tool it has nothing to use on.

**Any Chromium will do**, and the setup screen lists the ones it found. `milo setup` → Tools →
Browser → **Browser to run** enumerates the favourites — Chromium, Chrome, Brave, Edge, Vivaldi,
Opera, and forks like Helium — from `PATH`, from `/opt`, and from the places each platform keeps
them, de-duplicated so `/usr/bin/chromium` and the binary it points at are one row rather than two.
Firefox is not on that list and will not be: it speaks WebDriver BiDi, so it would need a driver of
its own. `browser.chromePath` names one directly. When the machine has none, the same screen
downloads a [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) build into
`~/.milo/browser/chrome/` — an archive, no installer, no sudo, and the same on every platform.
`apt install chromium` works too.

**Three tools, split by side effect.** `browser_open` (a URL) and `browser_snapshot` (the page again)
are read-only, so looking around never asks. `browser_act` clicks, double-clicks, types, presses,
hovers, scrolls, chooses and uploads, and it is the one that asks — because clicking is where the side effect actually
happens. There is no `navigate` action inside it: two ways to change page would be two names for one
thing.

**What the model is shown** is what decides whether it picks the right element:

```
https://example.com/checkout — "Checkout — Example"
h1: Your order
(400 characters of the page's own words)

r4   textbox   "Search"
r5   link      "Item 0"
r6   combobox  "Choose Small"
r7   button    "Go"
r8   textbox   "Password"             [required]  <password field — Milo does not fill this>
(… 34 more — use mode "text" to see more of the page)
```

Not the HTML, which is mostly markup to read past, and not a screenshot, which costs ~1500 tokens of
prefill on every step after it and carries no element identity — so acting on one is guessing at
coordinates. A role, a name and a state per element, numbered, is enough for "click r7" to be a
complete instruction.

A picture is the one thing that has to be asked for by name, and there are **two** of them because
they are two different acts:

- `browser_snapshot` with `mode: "shot"` **reads** — the image comes back to the model, for the pages
  whose content is only pixels. Read-only, so it never asks.
- `browser_screenshot` **writes** a picture to a path, for the person: the terminal does not render an
  image, so a file is the only way one reaches them. It asks, in the modes that ask, because writing
  to a path is what asking is for.

They were one tool for an afternoon, and that was wrong in a way worth writing down: the write was
sitting inside a tool marked `readOnly`, so the permission policy — which reads exactly that flag —
let a screenshot to `~/.bashrc` through without a word. Two acts with different consequences are two
tools, which is why this codebase has `read_file` and `write_file` as well.

**A ref is good for one look.** Acting on one from an earlier look is refused rather than guessed at,
and every action already hands back the page as it is afterwards, so a fresh look is rarely a
separate call. The numbers count **up across the session** instead of restarting at one: numbering
from one each time would make `r2` always *some* element — the second one on whatever page is up now
— and a ref held from two looks ago would quietly click something else. Counting on, an old ref is
simply absent, and saying so is the only honest answer.

**The action and the observation in one call.** This is the shape the whole feature is built around:
an N-action task costs N tool calls plus one answer, not 2N. Measured with `npm run bench:browser`,
which serves its own page so the numbers do not depend on the network:

| | p50 | |
| --- | --- | --- |
| Chrome cold start | 317 ms | once per process, not per action |
| `browser_open` | 310 ms | a page load |
| `browser_snapshot` | **4 ms** | one CDP round trip, ~380 tokens of page |
| `browser_act` | **10 ms** | the action alone |
| `browser_act` + the look | 158 ms | the action, a 150 ms settle, and the observation |

Those are *local* numbers; the model round trip is seconds and is the same whether this feature exists
or not. The 150 ms settle is 94% of the second of those and is kept deliberately: looking at a page
the instant it was clicked shows the state before the click, and the model pays a whole extra round
trip — seconds — to find that out.

**The look is also what costs.** A snapshot rides every request that follows it, so ten actions would
otherwise carry ten copies of the same page's element list. `dropOldSnapshots` keeps the two most
recent and trims the rest to the line that says what happened, in the same in-place way
`dropOldImages` already did — and, unlike compaction, it runs **before every request inside a turn**,
because a turn makes up to 25 of them. Measured on a five-action task, the last request is 1,650
tokens unbounded and 740 with the rule. `browser.keepSnapshots` changes the two.

**Guardrails.** Milo starts a browser **of its own**, on `~/.milo/browser/profile/`, so cookies and
sign-ins survive a restart without the browser you are actually using ever having remote debugging
switched on. Attaching to one that is already running is opt-in (`browser.cdpUrl`), and the result
says which it used. Nothing on a page is an instruction: text telling the model to do something is a
finding to report. And `browser_act` **refuses** to fill a password, card or one-time-code field,
which is the one rule enforced at the point of the action rather than asked about — the person signs
in, does 2FA and pays themselves.

**Reaching logged-in accounts.** `milo setup` → Tools → Browser → **Profile** does this, and it is
worth knowing what it is doing, because two things stop the obvious version from working:

- **A profile cannot be shared with a browser that is already open on it.** Chrome refuses to start a
  second time against a directory in use, so "use my profile while I browse" is not a thing. The
  screen copies instead: pick the browser you are signed into, and the copy lands in
  `~/.milo/browser/profiles/<browser>/` with `browser.profileDir` pointing at it. Pick it again to
  refresh a copy that has gone stale.
- **Chrome 136 and later ignore `--remote-debugging-port` when the data directory is the browser's
  own default one**, and say nothing about it: the port file is simply never written, which looks
  exactly like Milo being broken. The setup screen spots a default profile path and says so in red
  rather than letting you find out at launch.

The copy is **selective**, which is what makes it quick: on the machine this was written on, 334 MB
of a 564 MB profile was `Service Worker` cache and the parts that carry a sign-in were 58 MB, copied
in 169 ms. It takes `Cookies`, `Local State`, `Preferences`, and the `Local Storage` and `IndexedDB`
that single-page apps keep their tokens in — because a session is not only cookies — and leaves every
cache behind. It is also tightened to `0600` on the way in, whatever the source's modes were: these
are session cookies.

The route that needs no copy is `browser.cdpUrl`: start your browser with remote debugging reachable
(the `chrome://inspect/#remote-debugging` checkbox is the sanctioned switch, and the only one that
works on a real profile since 136), point `cdpUrl` at `host:port`, and Milo opens a tab of its own in
the browser you are already signed into. Or simply sign in to Milo's own profile once with **Window**
set to `visible` — it is kept, so tomorrow it is still signed in.

```yaml
browser:
  enabled: true
  headless: true
  keepSnapshots: 2
```

`chromePath` names a binary instead of searching `PATH`, `profileDir` a profile instead of its own,
and `cdpUrl` attaches to a browser already running. The setup screen is where the state is visible:
**Tools** says `web search exa · browser` once either is set up, and its two rows carry the real
status. `milo serve` adds `browser headless` or `browser off` to its one boot line, because a
capability that only exists in a daemon's tool catalog is otherwise invisible. Like `web_search`, it
is deliberately not a badge in the CLI header: it is an install-wide capability, not a per-turn knob,
and a badge for a feature most installs never turn on is noise.

**Where the setup screen puts things.** `Tools` holds the optional *capabilities* — web search and
the browser, one row each, off unless set up — because that is the question the section answers:
which tools does this install have? `Permissions` holds the *policy* for running them (`ask`/`auto`/
`yolo`, the allow and deny lists, the reviewer threshold). They were one screen called
"Tools & permissions" and it was the wrong shape: the policy applies to every tool in the same way
whichever capabilities are installed, while a capability is on or off by itself. Splitting them also
gives the third and fourth capability somewhere to go.

### Display

How much of a turn you get to see is a per-install setting, not a per-surface one, so `/tools` typed
in Telegram applies to the terminal too — and the other way round. The bot gateways read it from
disk on every turn, so a change takes effect without restarting `milo serve`.

```yaml
display:
  tools: full
  thinking: on
```

A config that still says `true`, `false`, `brief` or `full` loads fine: anything that showed the
reasoning reads as `on`.

| Setting | Values | What it does |
| --- | --- | --- |
| `tools` | `full` (default) | The tool call with its arguments: `⚡ shell_command npm test`. |
| | `name` | Just which tool ran: `⚡ shell_command` — the answer to "what is it doing?" without the argument dump. |
| | `off` | No tool lines at all. |
| `thinking` | `on` (default) | The reasoning is shown under the question it belongs to, and stays in the transcript. |
| | `off` | No reasoning at all. Display only — the model reasons either way. |

A tool that **fails** is reported whichever level is set (`❌ shell_command failed`), and the CLI
stops naming the tool in its status line when `tools` is `off`: hiding that something went wrong is
worse than the noise it saves.

The reasoning lives **in the transcript**, under the question it belongs to: the line saying how long
the model took to start (`✻ Thought for 8.2s`), and the reasoning itself beneath it when it is being
shown. It used to be a pane of its own above the input, which existed only while a turn ran, took
rows away from the transcript, and — sitting outside the transcript's order — read as mixed in with
the tool lines it sat beside.

A bot appends **one** line instead — `💭 the first line of the thought` — because it edits a single
message and the whole reasoning would crowd the answer out of it. So a chat surface differs from the
terminal only in how much of the thought fits: the one line when `on`, nothing when `off`.

Thinking and answering are **two fields** on the wire: `content` for the answer, `reasoning_content`
(or `thinking`) for the thought. Milo keeps them apart the whole way to the screen — but a provider is
free to fill one field with both, and then no surface can tell a model that answers in its thinking
from one that is thinking and has not answered yet. Two rules follow, and both exist because that
case is not hypothetical:

- A turn that says **nothing in the answer channel** keeps all of its thinking: that is the thought
  the turn ends on, the one a tool call followed, and the one too fast to be worth a line. It is the
  answer, whatever channel it arrived in. Without it, a mixing provider's answer vanished the moment
  the turn ended — a second after it had been on screen.
- `/thinking off` on such a model hides the answer with the thinking, so the turn **says so** instead
  of going quiet.

`MILO_DEBUG=1` prints what each response actually carried — `0 chars of content, 31 chars of
reasoning, finished tool_calls` — which is how the two cases are told apart.

Each level that takes something away is visible in the CLI header (`[tools name]`, `[thinking off]`),
and the effort sits beside the model name — `effort medium` unless it was changed. A state you cannot
see is a state you blame on something else, and the missing badge cost exactly that: a hidden
reasoning pane is indistinguishable from a command that did nothing. All three are also spelled out
in `/status`, and `/thinking` says which way it went and that it only changes what is shown — the
question "so does the model think less now?" is the one it exists to answer.

`/tools`, `/thinking` and `/effort` are also the **Display** section of `milo setup`, which is where a
bot that answers several people has to change them: all three are locked from a chat there.

The CLI's palette is chosen for contrast rather than for looks: every colour clears 4.4:1 against a
light background and 4:1 against a dark one, which is as much as a single tone can do against both.
Faint greys and the terminal's own `dim` attribute were tried and dropped — a theme is free to map
`gray` to something 2:1 from its own background, and this one did.

### Reasoning effort

`/thinking` decides what you *see*; this decides what the model *does* — and it is the one that costs.
`reasoningEffort` (`low`, `medium` or `high`, set from `/effort` on any surface, from the Display
section of `milo setup`, or in the config) is put on the request as `reasoning_effort` on the OpenAI
wire, and mapped to a `thinking` token budget (`low` 1024, `medium` 2048, `high` 4096) on the
Anthropic one. It **defaults to `medium`**: every request carries an explicit effort, because
"whatever each provider and model makes of an absent field" was a value nobody could name and a label
— `effort default` — nobody could read. A provider that does not know the field ignores it; one that
rejects it fails loudly on the turn.

On a bot that answers more than one person `/effort` is **locked**, for the same reason `/mode` is:
what an answer costs is not one person's to change for everybody.

```yaml
reasoningEffort: low
```

The **internal calls do not follow it**: summarizing a transcript and writing a session recap are
mechanical, and asking a reasoning model in its own voice means it thinks about them — a quarter of a
minute of a turn, whose result nobody reads. Those two ask for `low` regardless, and if a provider
does not know the field at all the call is made again without it, because losing every summary to an
unknown field is the worse failure.

On the Anthropic wire, thinking on means the thinking blocks must come back with every follow-up
request, so the signature the wire puts on each one rides with it in the transcript and the block is
replayed ahead of the text and the tool call it belongs to. A thought without a signature is dropped on
the way out — the wire refuses a block it cannot verify — which is why the budget is only sent for the
turn itself and never for a mechanical call: the internal calls ask for nothing on that wire, so they
pay no reasoning tax. Thinking has only run against a fake so far; see the roadmap.

The terminal renders the answer as **light markdown**: a fenced code block keeps its code (the fence
lines go, the code is not reflowed as prose, and a long line is cut at the width instead of wrapping
mid-token), inline code and bold are styled, headings lose their hashes, and consecutive tool calls
stack with **no blank line between them** — a burst of calls is one activity, not a paragraph each.
Tables and nested lists are left as the plain text they are: the CLI is asked not to reach for them,
and half-rendering them reads worse than not trying.

A bot trims a turn that outgrows the message limit in the **middle**, keeping the beginning and the
end: the answer comes after the tool log, so trimming only the end is how a long turn loses exactly
the part that was worth reading.

### Output limit

The Anthropic wire has a hard default of 4096 output tokens. That is low enough to cut a long answer
in half — and to cut a `write_file` of a large file mid-JSON, which then looks like an invalid tool
call. OpenAI gets the provider's own default.

```yaml
maxTokens: 16384
```

Set `maxTokens` (or the **Output limit** row in `milo setup` → Display) to whatever the model really
supports; leave it out and each wire uses its own default. The default is deliberately conservative,
because asking for more than a model allows is a 400 on every request — worse than a trimmed answer.

A turn that ends because of the limit now says so, on both surfaces: the CLI prints `⚠ hit the output
limit — the answer was cut off` and a bot appends the same, instead of an answer that looks
complete.

### Measuring jev latency

The reviewer sits in the hot path, so latency matters:

```bash
npm run bench:jev          # needs COMMANDCODE_API_KEY (or CMD_API_KEY)
RUNS=10 npm run bench:jev
```

It prints p50/p95 latency and P(dangerous) per sample command. Identical commands are served from
an in-memory LRU, so a repeated command costs nothing; a request that exceeds `jevTimeoutMs` is
aborted and falls back to asking.

`npm run bench:browser` does the same job for the browser toolset — the measured numbers in
[Browser](#browser) come from it. It serves its own page, so it needs no network and measures the
same thing on every machine.

`npm run check:browser` is its counterpart, and it checks the other thing: one run per verb in the
toolset, each on a fresh page, asserting that the **page reacted** — the form submitted, the file
arrived, the hover fired — rather than that the call returned without an error. It exists because
`upload`, `hover` and `double_click` sat in the schema for days having never been run, and because
`click` itself was missing from the first version of the check: a vocabulary of verbs nobody has
exercised only looks closed. Both scripts need a browser and are not in CI.

### Web search

```yaml
search:
  provider: exa
```

Three providers behind one interface; `milo setup` → **Tools** → **Web search** picks one and asks for
its key.

| Provider | Free tier | Latency | What comes back |
| --- | --- | --- | --- |
| `tavily` | 1,000 credits/month, no card — requests stop when the credits run out | ~450ms | Curated page content |
| `exa` | $20 on signup, then $10/month, no card | 180ms–1s (`fast` mode by default) | The passages relevant to the query, plus the page text |
| `parallel` | 5,000 requests/month, then $1 per 1,000 | ~700ms in `fast`, ~200ms in `turbo` | Dense excerpts from its own index |

The key comes from `TAVILY_API_KEY`, `EXA_API_KEY` or `PARALLEL_API_KEY`, or from `milo setup` →
API keys. Each provider has its own slot in `auth.json`, so switching providers does not reuse the
previous key. Exa and Parallel report a publication date per result, and it is shown next to the
title.

Without a configured provider, `web_search` is simply not registered — the model never sees a
tool it cannot use.

### Subagents

`task` hands a self-contained piece of work to a subagent: it runs the same loop with a **fresh
transcript** and returns only its final report. A broad search, a read through twenty files, a long
investigation — the tool calls on the way stay in the subagent and never enter this conversation, so
what the parent pays for is the answer, not the search.

**It is on request only.** Milo does not delegate on its own initiative: the tool's description tells
the model to reach for `task` only when the user has asked for a subagent or for the work to be
delegated, and to do the work itself otherwise. The direction is deliberately conservative for now —
the isolation is worth having, but not at the price of a model that quietly hands its work to
something the user cannot see.

The subagent does not see the conversation and cannot ask anything, so the `task` prompt has to carry
everything the subtask needs. It runs the same tools the parent has, **except `task` itself**: a
subagent cannot delegate again, so a delegation is one level deep rather than a chain that only
`maxSteps` would end.

Nothing about permissions changes underneath. `task` never asks on its own — it has no side effect of
its own to confirm — while every write or command the subagent attempts is put to the user the same
way the parent's would be, one at a time. A `deny` entry for `task` still blocks the delegation
outright.

What is *not* live is the subagent's own activity: the turn shows the `🤖 task <description>` line and
whatever confirmations it asks for, but the reads and searches it runs in between are not streamed —
they exist only inside the subagent, and only the report comes back. That is the cost of the
isolation, and streaming them would mean reworking the loop to carry a second stream.

## Sessions

A conversation is a **session** with its own name (`calm-otter-7`), stored as one JSON file under
`~/.milo/sessions/`. The transport address — a Telegram chat, a Discord channel, the CLI — is only
a **binding** to the session currently attached to it, so the same session can be picked up from any
gateway. Bindings live in `sessions/bindings/<scope>.json`, one file per address: a single shared
map meant a read-modify-write of the whole thing on every turn, which drifts the moment `milo` and
`milo serve` run at the same time. (A `bindings.json` written by an older version is still read, and
each scope moves to its own file the next time it is bound.) Ids are claimed by creating the record
file exclusively, so two processes cannot hand out the same nickname.

Two turns never run on one session at once. A turn takes a **lease** for as long as it runs — a lock
beside the record for another process, a mutex in memory for another conversation in this one — so
two terminals, which both bind `cli:main`, take turns instead of folding into each other. A turn that
has to wait says so rather than looking like a model that is thinking, and Ctrl+C gives the wait up.
The record also carries a **revision**: a save names the revision it was built from and is refused if
the file has moved past it, so a writer that stepped outside a lease is told about it instead of
quietly erasing what landed in between. A session is reread under its lease before a turn starts, so
turns another Milo wrote in the meantime become the base of the transcript — and the surface says
what changed: the turns it added, and any it summarized away, since the answer then draws on more
(or less) than the screen has shown.

| Command | What it does |
| --- | --- |
| `/new [title]` | Starts a fresh session and binds this conversation to it. |
| `/sessions` | Lists the saved sessions, most recent first. |
| `/resume <id>` | Binds this conversation to an existing session. |
| `/stats` | Name, timestamps, message/turn counts and context size for the current session. |
| `/clear` | Forgets the current session's transcript (destructive). |

In the terminal, `milo` begins a new conversation every time it opens, and the one you were in stays
on disk, listed by `/sessions`. `milo --continue` picks that one back up, and `milo --resume <id>`
opens a specific one.

That rule means the directory grows a file per run, so `sessions.maxSessions` (default 50) caps it: at
startup the oldest sessions beyond that are pruned, and one a scope is still bound to is never touched
— a binding to a session that is gone would only silently start a new conversation on the next
message. A pruned session's recap goes with it. The prune is off the critical path: it runs on the way
in and never holds up the first turn. `0` is how the cap is lifted — every session is kept — and it is
the same word `history.windowDays` uses for "keep the lot". Nothing is lost either way: what pruning
trims is the working transcript, and the log `recall` and `search_history` read is not touched by it,
so an install that would rather grow than forget pays in disk and nothing else.

Memory is keyed to the install, not to the session or the conversation: what you told Milo in the
terminal is there on Telegram, and a `/new` never changes what it remembers.

Leaving a session — a `/new`, or a `/resume` away from it — writes a short **recap** of it, in the
model's own words: a few bullets on what it was about and what it settled. `/sessions` shows the
recap where it used to show the first line of the conversation, so the list reads as a list of
subjects rather than a list of opening questions, and `recall` ranks them to answer "which
conversation was that?".

The recap is kept **out of the session file**, in `sessions/recaps/<id>.json`, because a session's own
file is written a turn at a time and a recap in there would be a second writer to it — with the
session winning and the recap vanishing, or the recap winning and a turn being lost. Apart, neither
can damage the other. Each recap names the transcript version it was written from, so a turn landing
while it is being written needs no fixing up: the recap stops matching, drops out of the listing, and
the next one written describes the whole thing. A recap only ever moves forward: a slower writer that
finishes last, describing an older transcript, cannot replace one that is already newer and take its
bullets out of the listing. The model call runs in the **background**, so a switch
never waits on it; it is skipped when the session is empty or its recap is still current, and a recap
that fails is simply not written — leaving a session never fails because its recap did.

On Telegram and Discord, `/new`, `/sessions` and `/resume` only work on a single-person bot (exactly
one id in the allowlist). On a shared or open bot they are locked, so nobody can switch into someone
else's sessions.

### Compaction

A long session would otherwise hit the model's context limit. Once a request passes
`sessions.compactAt` **of the model's context window** (estimated at ~4 characters per token), the oldest
turns are summarized in one model call and replaced by an `## Earlier in this conversation` section of
the system prompt; the last `sessions.keepTurns` turns are kept verbatim. The cut always lands on a
user turn, so a tool call is never separated from its result. If the summary call fails, the turns are
dropped anyway — a request that fits beats one the provider rejects.

```yaml
sessions:
  compactAt: 0.7
  keepTurns: 8
  compaction: true
```

The window itself comes from public model metadata — the OpenRouter catalog, which needs no key and
lists `context_length` per model — looked up once per model and cached in `~/.milo/context-windows.json`
for a week. `sessions.contextWindow` overrides it for a model the catalog gets wrong or does not know.

A flat ceiling was the wrong shape for this and the reason the setting exists: the same 12000 is a
third of a small window and **1.1%** of a million-token one, so a session would summarize on every
turn for nothing — a model call per turn whose answer nobody sees, and about eleven seconds of a
fourteen-second wait. `maxInputTokens` is now only the fallback for when nothing knows the window.

That budget counts the **system prompt too** — the persona, the tool list, the recalled memories and
the running summary ride along with every request. Counting only the transcript let the real request
go over while the estimate said it was fine. `/stats` reports both numbers for the same reason, and
shows them against the budget (`~9.5k of 12k tokens`) — a token count with no ceiling says nothing
about whether the session is anywhere near one.

`keepTurns` is where the cut prefers to land, not a promise it keeps: when the turns it protects are
themselves bigger than the ceiling — eight long turns against a 12k fallback, say — the cut recuses
past the floor until what is left fits, keeping as many of them as it can and never folding the most
recent turn, which is the question being answered. When even that turn plus the prompt is over the
ceiling, no fold can bring the request under, so the summary is **not called at all** — folding cannot
make the request smaller than the turn it keeps, and paying for a summary that cannot help is exactly
the model call per turn the old rule made. A session can still sit over its trigger, but it no longer
pays a model call every turn pretending otherwise. The CLI names the compaction it does run in the
wait, so it stops looking like the model:

```
✻ Thought for 12s (4.2s compacting)
```

## History

Sessions are the working state: they get cleared, compacted, deleted. The **history log** is the
record that outlives them — one append-only JSONL file per day under `~/.milo/history/`, written
`0600`, a line per event: every question, every answer, every tool call with its arguments and its
result, and the model's reasoning, each tagged with the session's name and the address it came from.
A turn writes its lines in one `append`, so the worst a kill can leave behind is a torn last line —
and the reader skips that instead of failing.

The reasoning is the part that had nowhere to go before: it was streamed to the screen and died with
the turn. It is now kept in the transcript, and it is not part of the conversation — replaying it
would pay for the same tokens twice — so neither wire sends it back, with one exception: the Anthropic
wire signs its thinking blocks and requires them echoed with each follow-up request once thinking is
on, so a signed thought is replayed as a thinking block and `estimateTokens` counts it, while an
unsigned one is dropped on the way out and costs nothing. On the OpenAI wire reasoning is never sent
back at all.

`search_history` is the read side: give it terms (all of them have to appear, any case) and it returns
the newest matches from the last 30 days, reading the reasoning, the tool arguments and the tool
results as well — which is what makes "what did we try for X?" answerable. Pass `session` to stay
inside one conversation; `recall` is what names it. The reply is capped and says when there were more
matches than it showed.

Recall reads the log through an index of what you typed, rebuilt from the log and bounded by a
**recency window**: `history.windowDays` (default 365) is how far back a turn stays reachable, and a
day that falls out is dropped from the index rather than refused. `0` keeps every day. The log itself
is never trimmed on its own — it is the record — so `milo history` reports how many day-files it holds
and what they cost, and `milo history trim --older-than <days>` (or `--before <date>`) deletes the
days you name, dropping the same days from the index so a deleted turn cannot answer a recall.

### Taking a conversation out

`/export` writes the current conversation to `~/.milo/exports/` — Markdown by default, `/export json`
for the entries themselves — and replies with the path, the counts and the size. It is the whole log:
every message, every tool call with its arguments and its **full** result, and the reasoning, in the
order it happened.

It reads the **history log**, not the session's transcript, and that is the point. A transcript is
compacted as it grows and its old screenshots are dropped, so exporting it would export what is left
rather than what happened; the log is the complete record and it is what the export is for. A session
that has not had a turn yet exports nothing, and says so rather than writing an empty file.

This is also the answer to "what actually happened in that turn?" — the log has the tool arguments
and the results verbatim, including the ones that failed, which is not something the transcript
guarantees.

`recall` answers the other half of the same question — not *what* was said but *which conversation*.
It ranks the saved sessions by how well their recap, title and first words match the query, with a
recency bonus allowed to reorder but never to qualify: a session that shares no word with the
question does not come back for being recent. It is the map; `search_history` is the territory.

Plain text on disk is what keeps everything else working: `grep`, `jq`, `tail -f`, and Milo's own
`read_file` and `grep`. `search_history` still walks the day files, newest first, and stops at the
limit — the honest trade for a tool that is called now and then. What does have an index is recall,
which runs before *every* turn and cannot afford to walk anything: `~/.milo/history/turns.db`, derived
from these files and rebuildable from them. The paragraph above used to end by calling that a thing for
the future; it is the present, and it is still not the truth about the log — deleting it costs one
rebuild (see [Memory](#memory)).

## Memory

Memory sits behind a thin, vendor-agnostic interface (`remember` / `recall`). Milo's own store is
**one SQLite file** at `~/.milo/memory/memory.db`, written `0600`, searched with FTS5/BM25. No account,
no key, no service, no network — with an embedder off, nothing you said leaves the machine. Third-party
backends (mem0, Honcho, Zep/Graphiti, Letta, Hindsight) would plug in behind the same interface, and
nothing in the agent calls a vendor SDK directly; the switch that chose between two Milo-owned stores
is gone, because two stores meant two sets of behaviour to keep in step.

**Why not one of them now.** Recall runs *before every turn* — `session.ts` awaits it ahead of the
model request — so whatever answers it sits in front of every message. Those backends are Python or
Docker services, or HTTP clients to one, and most want a graph database and an LLM on the write path:
a round trip per turn, a hard failure when offline, and the transcript on somebody else's machine.
mem0 is the exception worth naming, because its Node build does run in-process — but `add()` is an
LLM call by default (it throws without one), its telemetry is on by default, and it pulls a native
SQLite peer. The evidence points the same way for a store this small: in BEIR's out-of-domain results
a tuned lexical baseline matches or beats dense retrieval, which is the regime a few hundred private
notes live in, and Honcho's own benchmark notes that below roughly 50k tokens its machinery is not
worth the overhead. Embeddings are an **opt-in** layer fused on top of what is here rather than where
it starts — see [Recall by meaning](#recall-by-meaning-off-by-default).

### Facts in the store, turns in the log

- **`fact`** — something worth keeping past the conversation: what the `remember` tool saves, and what
  the end of a turn is read for. This is everything the store holds, and **nothing ever evicts one.**
- **the turns themselves** — what the person typed, which is already in the history log, indexed from
  there by `turns.db`. One copy, in the artifact that outlives every session, `/clear` and compaction.

Recall reads facts first and fills the rest of the reply with turns. The split is what keeps a durable
note from being drowned by chatter: an undifferentiated list with one cap dropped the oldest 100 of 600
items, fact or not — measured, not suspected. Keeping the turns in the store as well was the previous
version, and it meant the same sentence in two places, one of them capped at 2,000, both able to drift,
and a `/memory` listing full of session small talk.

Why the log rather than a second store: recall needs the person's own words, and the log already is
them — every turn this install ever took, from every surface, for as far back as it goes. An earlier
draft read the log directly and paid 2.6–4.7 ms per question for 309 entries, growing linearly with
every turn ever taken. The index makes that 0.2–0.3 ms and flat, reaches further back than the cap it
replaced, and can be deleted at any moment because nothing in it is the only copy of anything.

The same note saved twice is one row (a hash of the case- and space-normalised text), so re-saving a
fact does not dilate recall. A turn collapses the same way, to the newest telling — the verbatim
history stays in the log, where `search_history` reads it.

The `remember` tool is the deliberate half, and the end of a turn is read for facts as well — a
preference, a convention, a decision. Recall is lexical, so the tool is told to write short standalone
sentences in the user's own terms and not to save what is already in the code or the transcript; it
takes a batch, so one call can save several facts.

### The query, and the 90× that came out of the plan

`recall` turns the question into an FTS5 `MATCH`: the words are OR-ed, so the answer is still
"anything sharing a word" — the promise the keyword store made. The tokenizer is what keeps a whole
sentence safe to hand to the engine, and `remove_diacritics 2` is what makes `voce` find `você`,
which in Portuguese is most of the difference between a store that works and one that does not.

The join in that query is written `cross join`, and it is load-bearing rather than style. With a
plain join and no `sqlite_stat1` — the state of a store that has only ever been written to — Node 22's
SQLite drives from `memories` and probes the virtual table **once per row**: measured on 500 entries,
**53 ms per recall against 0.6 ms** when the FTS index drives. Pinning the order makes the plan right
without depending on statistics, which would have to be refreshed and would be wrong again the week
they went stale. It is also version-dependent — Node 26's SQLite picks the good plan on its own —
which is precisely why it is pinned rather than left to the planner, and why a test reads that
query's own query plan: both plans return the same rows, so no behavioural test can tell them apart.

The turns are queried by a second copy of the same SQL, pinned for the same reason, and the two answers
are merged in `installMemory`: the facts, then the turns the facts did not already cover, cut to
`recallLimit` and re-scored so `1` is still the best line the model is reading. Order is by **evidence** and
then by how well each note matched: what the question's own words reached comes above what meaning reached,
a fact wins an exact tie, which is what keeps a durable note from being drowned by the last thing said. The
history is not asked at all only when notes the *words* reached already fill the reply — and that
qualification is not a detail. The plain version of the shortcut ("the facts filled it") was measured
starving the log: with meaning padding the facts out to five from a store that held no word in common, three
questions whose answer had been *said* rather than saved stopped being recalled at all.

### Recall by meaning, off by default

Words match words. A note that says "editor" is not found by a question that says "IDE", so there is a
second, **opt-in** signal: an embedding model scores the same rows, and what it finds is added **after**
what the words found, never above it. That order was measured, and getting it wrong is what made the first
version look bad: interleaving the two by rank (reciprocal rank fusion) let a near-but-unrelated note
displace the one that matched the question's own words — precision fell from **73.5% to 23.0%** and recall
from 97% to 90.9%, the answer lost on questions the words had already answered. The vectors still
**introduce** a note the words never matched, which is the whole point of having them; they just do not get
to outrank one.

There is deliberately **no similarity cutoff**. Measured on 8 notes and 32 questions, across two
models, the scores of a correct note (0.01–0.70) overlap the scores of a wrong one (0.05–0.31): no
number separates them. An earlier 0.16 threshold looked right on nine questions and failed on 32, and
there is a test that says so, so nobody re-adds one by reflex.

Two ways to get a model, both offered by `milo setup` → **Memory**:

- **On this machine.** Milo downloads its own Ollama build and unpacks it under `~/.milo/embed` — not
  through the distribution's package manager, which needs sudo and is named differently everywhere.
  The download is checked against the sha256 the release publishes, the engine is started on a private
  port with the model it pulled (`embeddinggemma`, 593 MB, against bge-m3's 1.08 GB), and it dies with
  the Milo process that started it. An engine Milo did not start is never touched.
- **On OpenRouter.** `nvidia/nemotron-3-embed-1b:free` by default, with the key read from the same
  `auth.json` slot the chat models use, so one key entered serves both. The free route means the notes
  leave the machine and its 512-token context truncates a long pasted turn; the screen says both
  before the choice is made.

Off by default, and it degrades rather than fails. With no `memory.embedding` in the config, recall is
BM25 exactly as before; an engine that is down, slow or refusing a note falls back to words with one
log line. A note the model permanently rejects (400/413/422) is set aside rather than retried, so it
cannot block the notes behind it, while a transient failure — network, 5xx, rate limit — is retried.

What it does not fix is the order among notes that do match, and it never trimmed the notes that do not —
which is what the coverage rule below is for.

### What recall gets right

`npm run eval:memory` scores recall against a checked-in set: 36 notes, 33 questions each carrying the note
that answers it, 13 more asking for those same notes **in other words** (no word in common with the answer),
and 8 questions nothing in the store answers. It reports precision@5, recall@5, MRR, the share of
unanswerable questions that came back with a note anyway, and how many of the reworded ones came back at all.
`--semantic` adds the rows that use the embedder the install is configured with, skipped with a line when
there is none.

| | precision@5 | recall@5 | MRR | no-answer | reworded | p50 |
| --- | --- | --- | --- | --- | --- | --- |
| words only | 49.2% | 97.0% | 0.939 | 0% | 0/13 | 0.19 ms |
| words + coverage | **73.5%** | 97.0% | 0.939 | **0%** | 0/13 | 0.22 ms |
| + embedder | 20.0% | **100%** | **0.955** | 100% | **11/13** | 472 ms |
| + embedder + coverage | 28.6% | **100%** | **0.955** | 100% | **11/13** | 455 ms |

The number worth reading first is `no-answer`, which was **62.5%** before, and the cause was not the ranking
at all: `qual`, `como`, `pra` and the rest of what makes a question a question were being treated as subject
words. "Qual a capital da França?" matched a chat turn for containing `qual` — one shared word, and the whole
of why five of eight unanswerable questions came back with something. They are stopwords now, which is what
that list already did for `que`, `de` and `para`, and nothing is lost by it: a question keeps every word that
is actually about something. **That fix is the whole of the `no-answer` column** — the embedder puts it back
to 100%, because a vector search always returns its nearest notes and nothing in it can say "none of these".

`coverage.ts` drops the tail, and it is less than the reranker this was going to be. Re-ordering the
candidates *within* the word matches was tried first and measured at **nothing** — the same precision and the
same MRR, to the digit — because `bm25` was already putting the right note first, so the signals that only
re-ordered were deleted rather than kept as decoration, exactly as the lightpanda and the `brief` mode were.
What was left is the one thing no ranking can do for itself: noticing that most of what a keyword match
returns is notes that *share a word*, and that the reply was barely half answers. So it measures one thing —
how much of the question a note carries — and keeps only the notes within a fraction of the best. Relative on
purpose: the absolute floor was measured and removed, because those bands overlap, and the gap is what
separates them. A note the words never matched, that only meaning brought in, is never trimmed — it is asked
for only when the words left room, and it is placed after them.

**What the last two rows cost, exactly.** The embedder is what reaches the reworded questions: **0/13 to
11/13**, and it recovers the last three points of plain recall — including the one question in the main set
that shares no word with its answer. It also improves MRR, and it is the only thing here that can. What it
costs is on the other three columns: precision falls, because a reply that gets filled with neighbours is
mostly neighbours; `no-answer` returns to 100%, for the reason above; and the round trip is measured at ~455
ms, paid on every question the words did not fully answer. That is the honest shape of the trade, and which
side of it is right is not something these numbers decide — they measure *retrieval*, not whether the model
answers better with four extra lines in front of it.

All of it is arithmetic over at most a couple of dozen short strings. It runs before every turn, so the
budget is a millisecond, and `test/memory-eval.test.ts` holds the floors — and was seen failing, by breaking
the trim on purpose, before it was trusted. The reworded axis is deliberately not asserted there: it only
moves with a model, and a test that needs the network is not a floor anything can stand on.

### What it costs

`npm run bench:memory`, p50 over 200 recall runs and 20 remember runs — the same range on Node 22 and
26, which is the point of pinning the plan:

| | recall | p95 | remember |
| --- | --- | --- | --- |
| facts, 500 notes | **0.16 ms** | 0.90 ms | 0.94 ms |
| facts, 5,000 notes | **0.35 ms** | 7.21 ms | 0.80 ms |
| turns, 500 in the log | **0.19 ms** | 0.79 ms | — |
| turns, 5,000 in the log | **0.31 ms** | 5.08 ms | — |

Indexing the log the first time is the one cost a question never sees: 15 ms for 500 turns, 126 ms for
5,000, and then nothing — each later pass reads only what was appended since. The same question asked
of the log without an index is 2.6–4.7 ms at 309 entries, and it grows with every turn ever taken.

Recall is the hot path and lands in the hundreds of microseconds; the model round trip that follows is
seconds and is the same either way. Those are local numbers only.

### The old store

The JSON-per-scope store is gone: `memory.db` is the only backend, and the `backend` switch that chose
between them is gone with it. The first open of the database **imports** whatever is in
`~/.milo/memory/*.json` — once, recorded in the store's own `meta` table, keeping each item's original
timestamp and taking its layer from the tag it already carried — and then **leaves the JSON files
where they are**. They are the record of what was said before it, and nothing reads them again. Where
the old store tagged an item `user` it was a turn, not a fact: those are skipped, because the log is
where turns live and importing them would put the chatter back.

The first open after that also **drops the copied turns** the store used to keep: any row still in it
goes, and the `kind` column with them, since every one of those sentences came from the log in the
first place. The file does not shrink for it — `DELETE` frees pages for reuse, and `VACUUM` is what
returns them to the filesystem — so what changed on disk is the schema, not the size.

Recall is not the only thing that reaches the model, and the rest is untrusted by construction: a
remembered line comes from something the user typed earlier, a compaction summary comes from the
transcript, and `web_search` snippets come from the open web. All three are fenced in the prompt
(`<memories>`, `<summary>`) with a line saying they are data and not instructions, and the reviewer
prompt says the same about the action it is judging.

`milo setup` → **Memory** shows what is actually in the store — facts, turns, size and where it lives,
with the recall-by-meaning line beside them — read off disk on navigation, since the store is written
by turns and not by that screen.

## Skills

A skill is a **procedure** the model can pick up on demand: a `SKILL.md` that says how to do
something — a release process, a convention of this repo, a house style. Two places are searched,
and a name in the second overrides the same name in the first:

```
~/.milo/skills/<name>/SKILL.md            # every project
<project>/.milo/skills/<name>/SKILL.md    # this project only
```

The file opens with a small frontmatter block and then the instructions:

```markdown
---
name: deploy
description: How to cut and ship a release in this repo
---

1. Run `npm run build`.
2. …
```

`name` is optional — the directory name is used when it is absent — but `description` is not: it is
what the model sees, so a skill without one is skipped rather than indexed under a name nothing can
judge.

Only the **index** — each skill's name and its one-line description — rides along with every
request; the instructions are loaded by the `read_skill` tool **only when a task matches**, and that
tool is not registered at all when no skill is installed. Inlining every skill's body into the system
prompt instead would be a tax on every turn for procedures most turns never use, which is the whole
reason for the split.

Skills are read once, at startup, so adding one means restarting `milo` — the rule the bot allowlist
already follows. Editing the body of one that already exists does not: the tool re-reads it from
disk on each call. `/skills` lists what was found and where each one came from.

The directory is made for you: `~/.milo/skills/` is created at startup and when `milo setup` opens
its **Skills** section, because an empty directory nobody is told about is the same as no feature. A
project's `.milo/skills/` is not — Milo never makes one, or it would leave a stray `.milo/` in every
repository it was pointed at. The directory is Milo's own (`~/.milo/skills`); it does not read
`~/.commandcode/skills`, though a symlink across is all it takes to share them.

### Installing skills

`milo skills` is what fills those directories:

```bash
milo skills                 # what is installed, in both scopes
milo skills available       # the skills that ship with Milo
milo skills find [query]    # the most-installed in the directory
milo skills add <source>    # a local path, an http(s) URL, or owner/repo
milo skills remove <name>   # delete one
```

A `<source>` is anything the ecosystem hands out: a local directory holding a `SKILL.md`, a direct URL
to one, `owner/repo` on GitHub, or a **`skills.sh` page** — the directory's pages encode the same
`owner/repo` in their address, so a link copied from there installs, no scraping involved. A repository
holding several skills makes you pick with `--skill <name>` rather than guessing, and `--project`
installs into `<cwd>/.milo/skills` instead of `~/.milo/skills`. The same `SKILL.md` format is what
every other agent reads, so a skill from `npx skills` works here unchanged.

`milo skills find` reads the directory's ranking live, with each row's install count. `skills.sh` is
a website, not an API, so it reads the page — but only the shape it is built on: every skill is an
`/owner/repo/name` link, which is the address `add` already resolves, and the ranking *is* the order
of those links, so nothing has to be re-sorted and markup that moves around them does not break it.

`milo setup` → **Skills** shows the same top five next to the bundled pair. Each directory row carries
what the page prints — the repository and the install count — plus the one-line summary, which is only
on the skill's own page and so costs one more request each. `Space` **picks** a row (several at once)
and `Enter` installs what was picked: picking is the decision, and Enter is the only place it is acted
on, so nothing installs because the cursor happened to be somewhere. If the page cannot be read the
section says so and offers only what shipped with Milo. Being on that list is popularity, not a
review.

A few skills ship bundled (`milo skills available`), and they are not written anywhere until you
install one — which is what "off by default" means here: there is no enable flag, because *not
installed* is what off looks like everywhere else in Milo.

**What installing a third-party skill actually is.** A skill is instructions, not data. Milo fences
what it knows is untrusted — memories, a compaction summary and a search snippet arrive inside
`<memories>` and `<summary>` with a line saying they are data, not orders — but a skill *cannot* be
fenced, because being obeyed is the entire point of it. Installing one from the open registry is
therefore closer to installing code than to saving a note, and it is treated that way: the command
shows the name, the description, where it came from and how big it is, and asks before writing.
Nothing installs on its own, and **the model has no tool that installs anything** — a thing that can
install instructions is a thing that can be talked into installing more of them. The registry says as
much itself: it audits, and still cannot guarantee what a listed skill does. Read it first.

## Development

```bash
npm run dev         # run the CLI from source (tsx)
npm run serve       # run the bot gateways and the web UI from source
npm run build:web   # build web/ into web/dist, which `milo serve` serves
npm run typecheck   # tsc --noEmit
npm run lint        # biome lint
npm test            # vitest
npm run build       # bundle to dist/ (tsup)
npm run bench:browser   # what the browser toolset costs (needs a browser)
npm run bench:memory    # what recall costs, against the JSON store it replaced
npm run eval:memory     # what recall gets right (add --semantic for the local engine)
npm run eval:mem0       # the same set through mem0, verbatim and with its pipeline
npm run check:browser   # that every verb in it works (needs a browser)
```

CI (`.github/workflows/ci.yml`) runs lint, types, tests with coverage and the build on every push
and pull request, on Node 22 and 24, plus a smoke run of the bundled binary. One trap
worth knowing: with `NODE_ENV=production` exported in your shell, npm treats every install as
`--omit=dev` and **prunes the toolchain** — `tsc`, `vitest` and `tsup` disappear. Recover with
`npm ci --include=dev`.

### Source layout

- `src/core/` — the agent core, no UI or transport.
  - `providers/` — `Provider` interface + OpenAI/Anthropic adapters + wire factory.
  - `agent/` — the loop (`runAgent`), events, system prompt.
  - `tools/` — `Tool` interface, registry (zod → JSON Schema), built-in tools.
  - `search/` — `SearchProvider` plus the Tavily, Exa and Parallel adapters.
  - `memory/` — the `Memory` interface, the SQLite store behind it (`sqlite.ts`) and the coverage rule
    that trims a reply (`coverage.ts`), the JSON store it replaced (`local.ts`) and the one-time import
    between them (`migrate.ts`).
  - `skills/` — `SKILL.md` discovery, frontmatter parsing, and the loader behind the `read_skill` tool.
  - `browser/` — the CDP client, finding and starting Chrome, copying a profile out of another
    browser, the page observer, and the three tools.
  - `sessions/` — `SessionStore` interface + `FileSessionStore` / `MemorySessionStore`, the recaps
    kept out of a transcript (`RecapStore`) and their ranking (`rankSessions`), nickname
    generation, compaction (`estimateTokens` / `planCut` / `planCutUnderBudget` / `summarize`),
    retention (`pruneSessions`) and `/stats` formatting.
  - `config/` — paths, zod schema, presets, load/save, onboarding wizard.
  - `runtime.ts` / `session.ts` / `bootstrap.ts` / `history.ts` (the log and its readout).
- `src/gateways/` — `cli/` (Ink), `telegram/` (grammY), `discord/` (discord.js) and `web/` (the HTTP
  + WebSocket server, the hub that drives turns, the settings actions and the job registry).
- `web/` — the browser frontend (React + Vite), built into `web/dist` and served by `src/gateways/web/`.
- `src/bin/` — `cli.ts` (`milo`), `serve.ts` (`milo serve`), `web.ts` (`milo web`), and the plain
  terminal commands `skills.ts` (`milo skills`), `history.ts` (`milo history`) and `routines.ts`
  (`milo routines`).

## Roadmap

Everything known to be open — not only the features nobody has built, but the code that has never run
against the real thing, the debt this design is carrying, and the decisions nobody has made yet.
Grouped by kind of work; inside a group, by what it costs to leave alone.

**Built, never run against the real thing.** Each of these has tests, and every one of those tests runs
against a fake: the code is right about the shape of the API and unproven about the world.

- **The local embedding engine.** The release lookup, the archive download, its published sha256, the
  unpack, the child process on a private port and the model pull (`ollama.ts`) have only ever run
  against a fake release and a fake binary. One real run is the whole gap, and it is the path a person
  takes the moment they pick "on this machine" in setup. Real numbers to expect: 1.33 GiB for the
  engine archive, then 593 MB for `embeddinggemma`.
- **The bot gateways.** Telegram and Discord are exercised against fakes, so a real token is still
  needed to confirm the permission buttons, the rich messages and the turn queue against the live APIs.
  Routine delivery posts through the same calls, so it rides the same unproven path.
- **The routine loop's firing.** `nextRunAt` and the loop are unit-tested with a fake clock and a fake
  runtime, but no routine has ever fired inside a running `milo serve` against a real chat.
- **`web_search`.** `config.yml` has no `search` section, so the tool is not even registered right
  now, and the Exa and Parallel adapters have never been called for real.
- **The web surface.** The newest gateway, and the least driven: `milo serve` starts it now and it
  reaches the same core the other surfaces do, but nothing here has been used by anyone but its
  author — the settings screen's setup jobs in particular have only run against fakes for the embedding
  engine, and the whole surface wants a real session in a real browser.
- **Chrome for Testing.** The platform and URL mapping is covered; the download itself
  (`browser/install.ts`) is 15 %, so what has been proven is the shape of the index it reads.
- **`milo serve` assembled.** The pieces are tested and the daemon that wires them is at 78 %.
- **Anthropic thinking.** The `thinking` budget is sent and the signed thinking blocks are echoed back
  with each follow-up, but the path has only run against a fake: confirming it against the live API
  needs an Anthropic key.
- **The semantic half of the recall eval.** The coverage rule is measured with words alone. `npm run
  eval:memory -- --semantic` has never been run against a real embedding model here, so how much the
  vectors add — and whether the notes they pad a reply with are worth their lines — has no number
  behind it yet.

**Recall quality.**

- **The assistant's side of the index.** Recall reads what the person typed; replies are reachable only
  through `search_history`. Indexing them would roughly double the file to answer a question recall is
  not asked — worth revisiting before it is worth doing.
- **Nothing expires a fact, and nothing notices a stale one.** A fact contradicted by the live state is
  caught only by the line in the system prompt saying the live lines win.
- **Honcho and Zep.** mem0 has now been run against the same set (`npm run eval:mem0`), on the same
  notes, the same questions and the same embedder: verbatim it is a near-tie — better on nothing but the
  reworded questions, 12/13 against 11/13, and worse on recall, MRR and precision. With its own
  write-time pipeline on (`--infer`) it does not recall the notes it was given at all: 36 notes in,
  rewritten into its own words, **0/33** answers back as text and **37.5%** of the answer's words. A
  memory layer that rewrites what the person said cannot be asked what the person said. Honcho and Zep
  have not been run — both want Docker or a key, which is a thing to turn on rather than a thing to
  write.
- **Retrieval is not the answer.** Every number the eval reports is about what came back, never about
  whether the model answered better for it. A reply that is mostly neighbours in front of it is a cost
  nothing here measures.

**Not started.**

- **Plugins — the extension point that does not exist.** There are two today: `~/.milo/skills/`, which
  is prose and cannot add capability, and the tool registry, which is code and in-tree. A plugin is the
  missing middle: `~/.milo/plugins/<name>/` with a manifest declaring the tools it adds (name,
  description, argument schema) and an entry that is either an ESM module imported in-process or a
  command spawned per call. Its tools go through `permission.ts` unchanged, so a plugin's tool asks for
  confirmation exactly the way a built-in does, and installing one stays explicit — the person picks it
  from something, nothing auto-installs, the rule skills already follow. Two things to settle before
  code: in-process (fast, shares the process, and a bad plugin can take the turn down with it) against a
  subprocess (isolatable and language-agnostic, at the cost of a wire format and a start per call), and
  whether a plugin may ship skills and personas as well as tools.
- **`milo doctor`.** One command that answers "is this install healthy": the config parses, the keys are
  there, both databases open and pass `integrity_check`, the index agrees with the log it is derived
  from, `~/.milo` has the private permissions it is supposed to, and the legacy files are listed rather
  than silently ignored. Every piece of it exists as a function already; nothing assembles it, and today
  a broken install surfaces as a confusing turn instead of a diagnosis.
- **A usage ledger.** Providers already emit `usage` per call and `/stats` reports the session in front
  of you, but nothing is written down: no per-day, per-surface or per-model totals, and no cost estimate.
  A JSONL beside the history, or a table in the store, would make "what has this cost me" answerable —
  and one line at the `usage` event is where it starts.
- **Provider fallback.** One provider is configured, so a rate limit, a revoked key or a retired model
  ends the turn. A second entry to fall back to — with the surface saying which one answered — is small
  in `providers/create.ts` and one more row in setup.
- **Correcting a fact.** `/memory` lists notes and `forget` drops one, so a fact that has gone stale can
  only be deleted, never fixed — and now that facts are the only thing in the store, that is the whole
  editing story. Superseding a note in place is the gap.
- **Input other than text.** Pictures already arrive from the CLI and Telegram and go through one
  pipeline; a voice note is the same shape — fetch the file, hand it to a transcription model, put the
  text in the turn — and is worth doing only if that is how the person would actually talk to it.
- **More markdown in the Ink UI.** The terminal renders fences, inline code, bold and headings; tables,
  nested lists and links still arrive as plain text.
- **A window for models no catalog knows.** The lookup covers what OpenRouter lists, and
  `sessions.contextWindow` covers the rest by hand. A local model served by Ollama or llama.cpp could
  answer for itself — `/api/show`, `/props` — which would beat asking the user to type the number.
- **A fast step-decider for the browser.** Every action costs one model round trip today, and the tool
  is the single point where that decision is made — which is exactly where a decider that picks the next
  step in ~0.4 s instead (the `typesafe/jev` idea) would go, without redrawing anything. The closed
  shadow root is not on this list: it cannot be reached from outside a page at all, so it is a
  limitation of the browser rather than work Milo has left.
- **Remote desktops.** A cloud machine or a local VM, driven instead of this machine, so anything a
  browser cannot reach still has somewhere to run.
- **Per-person memory.** `MemoryScope.userId` exists and `installMemory` collapses everything into one
  install-wide scope on purpose, because an install serves one person. The day that stops being true,
  that one function is where the change goes.
