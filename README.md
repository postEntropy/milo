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
PROVIDERS  Command Code Provider API · OpenCode Zen · OpenRouter · OpenAI · Anthropic · Ollama · custom
```

The core never knows about Ink, Telegram, Discord or a browser: it hands each gateway a stream of
normalized `AgentEvent`s, and the gateway translates input in and events out.

## Requirements

- Node.js >= 22.13 (developed on 26). The floor is where `node:sqlite` stops being behind a flag; the
  memory store runs on it.
- An API key for one provider (or a local Ollama).

## Install & run

```bash
npm install
npm run dev            # start the interactive CLI chat
npm run dev -- --model deepseek/deepseek-v4-flash   # override the model for one session
```

On the first run an onboarding wizard asks for a provider, API key and model, and saves them to
`~/.milo/`.

- `Enter` **queues** a message behind the turn in flight; `Ctrl+Enter` **steers** it into the running
  turn, at its next step boundary. Ctrl+Enter needs a terminal that speaks the kitty keyboard
  protocol, which Milo switches on; where it is not supported, `Alt+Enter` steers. A message typed too
  late to be taken up becomes the next turn.
- `Ctrl+C` stops the turn and drops whatever was queued behind it, saying how many. The partial answer
  stays and the turn reads *stopped*, not an error. With nothing running, it exits.
- `↑`/`↓` walk back and forward through what was sent, kept in `~/.milo/input-history.json` — the input
  line history, a different thing from the turn log the model can search (see [History](#history)).
- `/new`, `/resume`, `/fork`, `/clear`, `/model`, `/provider`, `/setup` and `/compact` are refused while a
  turn runs.
- A turn that takes a second or more to produce output shows `✻ Thought for 8.2s` — or
  `✻ Thought for 12s (4.2s compacting)` when a summary call ran first — measured from the question to
  the first visible output.

## Configuration

- `~/.milo/config.yml` — provider, model, `maxTokens`, reasoning effort, memory, sessions, traces,
  display, permissions, browser, the web UI and enabled gateways. YAML so it can carry comments; every
  surface rewrites it, and a line you add survives any write that does not touch the key above it.
- `~/.milo/auth.json` — API keys, bot tokens and the Google grant (`0600`).
- `~/.milo/input-history.json` — what was typed at the CLI's prompt, for `↑`/`↓`.
- `~/.milo/task-lists.json` — the named task lists, shared by every session (see [Task lists](#task-lists)).
- `~/.milo/mcp.json` — the external tool servers, hand-edited (see [MCP servers](#mcp-servers)).
- `~/.milo/mcp-cache.json` — what each MCP server last said its tools were. Derived: deleting it costs
  one round trip.
- `~/.milo/sessions/` — one JSON file per session, one binding file per address, one recap per session
  left behind (see [Sessions](#sessions)).
- `~/.milo/memory/` — the memory store, `memory.db` (SQLite) (see [Memory](#memory)).
- `~/.milo/history/` — the log: one JSONL per day, plus `turns.db`, its index.
- `~/.milo/traces.jsonl` — the execution log: one line per model request, classifier, tool and turn,
  with its latency (see [Execution log](#execution-log)).
- `~/.milo/skills/` — one `<name>/SKILL.md` per skill (see [Skills](#skills)).
- `~/.milo/browser/` — the browser's own profile (`profile/`), a downloaded Chrome (`chrome/`) and
  profiles copied out of a browser you use (`profiles/`) — not the browser you use (see
  [Browser](#browser)).
- `~/.milo/exports/` — conversations written out by `/export` (`0600`).

A corrupt `config.yml` is reported at startup; the settings a running conversation changes read it
defensively, so a file that cannot be parsed leaves the current values alone. A write is an edit rather
than a rewrite: only the keys whose values moved are replaced, and comments and order stay.

Environment variables override stored secrets: `COMMANDCODE_API_KEY`, `OPENCODE_API_KEY`,
`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`,
`MILO_WEB_TOKEN`.
`MILO_HOME` relocates `~/.milo`; `MILO_DEBUG=1` logs memory calls and skipped stream chunks.

### Providers

| Preset | Endpoint | Wire |
| --- | --- | --- |
| `commandcode` | `https://api.commandcode.ai/provider/v1` | auto (Claude → `/messages`, others → `/chat/completions`) |
| `opencode` | `https://opencode.ai/zen/v1` | auto (Claude → `/messages`, others → `/chat/completions`) |
| `openrouter` | `https://openrouter.ai/api/v1` | OpenAI |
| `openai` | `https://api.openai.com/v1` | OpenAI |
| `anthropic` | `https://api.anthropic.com/v1` | Anthropic |
| `ollama` | `http://localhost:11434/v1` | OpenAI (no key) |

The Command Code Provider API needs a plan above Go (GOAT/Pro/Max/Team or the Provider plan) and uses
the same API key as the CLI.

`/provider` lists the presets that carry a key and switches the one in use — live, and saved for every
surface. `/model` does the same for the model: with no argument it lists the current provider's, with one
it switches. Adding a provider or a key is still `milo setup` → **Provider & model**. On a bot that answers
more than one person both are **locked**, like `/effort`.

OpenCode Zen serves each family on its own endpoint, so the preset uses the same auto wire: Claude ids
go to `/messages`, everything else to `/chat/completions`. Its GPT models live on `/responses`, which
Milo does not speak, so those ids are not offered.

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

Each conversation maps to its own session (`telegram:<chatId>`, `discord:<channelId>`), while what Milo
remembers is one store for the whole install. Replies stream by editing one message, and tool activity
becomes one line per call — a **quote box** with the tool's icon, its **bold** name and the one value
worth showing. A tool that fails adds `❌ <name> failed` as another line of the same shape.

A **shell command is the exception**: a fenced `shell` block of its own, with nothing above it — the
`shell` marker already says what it is — and the command whole rather than cut to a 120-character gist.

```shell
cd /opt/app && npm test -- --runInBand
```

A run of tool lines shares one quote, separated by a hard break so two calls cannot reflow into one
sentence; a thought (`💭 …`) is quoted too but never joins that run. The terminal draws the same lines.
On Telegram the answer goes out as an ordinary message with `parse_mode: HTML` — a **rich message**
(Bot API 10.1+) renders headings, lists and tables nicely but draws a fenced block differently from the
client's own, so a shell command does not come out as the code block it is meant to be. Bold, italics,
inline code, fenced blocks, quotes and links render; headings come out as a bold line, and lists and
tables as plain text. A message the API refuses falls back to plain text. For Discord enable the
**Message Content** intent. Tool confirmations arrive as inline buttons, and the turn waits for the press
and fails closed after five minutes.

### Who can talk to the bot

By default a bot answers anyone who finds it. Give it an `allowlist` to close that down:

```yaml
gateways:
  telegram:
    enabled: true
    allowlist: ["123456789"]
```

An entry matches either the sender's **user id** or the **conversation id** (chat, channel or guild),
so you can allow one person or a whole room. An empty list means anyone; a non-empty list fails closed
for everyone else, and a blocked sender is told their own id. `milo setup` → Gateways walks through
token → access → enable. The allowlist is read when `milo serve` starts, so restart it after changing
it.

Commands typed in the chat: `/help`, `/new`, `/sessions`, `/resume`, `/fork`, `/stats`, `/compact`,
`/export`, `/skills`, `/memory`, `/mode ask|auto|yolo`, `/yolo`, `/tools full|name|off`,
`/thinking on|off`, `/effort low|medium|high`, `/provider [id]`, `/model [id]`, `/clear`, `/status`.
A mode change from a chat is written to `config.yml` and survives a restart; sessions are written to
`~/.milo/sessions/` and survive too. The provider and the model are switched with `/provider` and
`/model`; adding a provider or a key still needs `milo setup`.

Three commands are about the turn rather than the session, so they are answered **outside** the queue —
a `/stop` that waited for the turn it stops would arrive after it:

| Command | What it does |
| --- | --- |
| `/stop` | Aborts the turn running now, and drops anything queued behind it. A message sent after that runs normally. |
| `/steer <text>` | Hands the text to the turn running now; it is read at its next step. |
| `/queue <text>` | Says it as its own turn, after the one running now. |

`/compact` queues like a session command: it folds the oldest turns into the summary, keeping the last
`keepTurns` turns verbatim, and says how many it folded — or that there was nothing old enough. If the
summary call fails the turns go anyway and the reply says so.

The terminal has the same four commands as names for its modifier keys — `/stop` is Ctrl+C, `/steer` is
Ctrl+Enter, `/queue` is Enter-during-a-turn — sharing the vocabulary and the decision of where a text
goes (`src/gateways/commands.ts`).

Both bots are thin shells over one transport-agnostic runner (`src/gateways/runner.ts`) plus a
`ChatSurface` interface, so streaming, tool lines, permission routing and truncation are shared and
unit-tested against a fake surface. A gateway must hand each turn to its `TurnQueue` rather than
awaiting it in the update handler: a turn blocks on the permission prompt, and Telegram's long polling
handles updates one at a time, so awaiting would deadlock. A message sent while a turn is running is
handed to that turn (taken up at the next step boundary); commands are never steered; and the queue
owns the abort handle, so a stop ends the message with `🛑 stopped` instead of an `AbortError`.

## Web

The fourth surface is a browser chat, on the same core, sessions and memory. It is served by
`milo serve`, so a daemon already keeping the bots up also opens the URL it prints:

```
Milo serving: telegram, web
Milo web · http://127.0.0.1:7717/?t=<token>
```

The token in that URL is the whole of the authorization, so loopback is the default and the address is
not meant to be shared. It is **minted per run unless one is stored**: a token meant to outlive the
process goes in `auth.json` → `gateways.web` (the `0600` slot the bot tokens use) or arrives as
`MILO_WEB_TOKEN`, which wins. It is not a field `milo setup` → **Web** edits — that screen is the
address; the token is set like the other secrets.

```bash
milo serve                 # the bots and the web UI
milo serve --no-web        # the bots alone
milo serve --web-port 8080 # one run on another port
milo web                   # the web UI alone, no bots, opening the browser
```

`milo web` starts nothing else and opens the browser at the URL; it takes `--host`, `--port` and
`--no-open`.

```yaml
web:
  enabled: true
  host: 127.0.0.1
  port: 7717
```

Where it binds comes from that section, and a flag wins over it for one run; `enabled: false` is
`--no-web` written down. **Anything but loopback is reachable from the network**, where the token is
the only thing in the way. `0.0.0.0` is what you bind, not a name another device can open: the boot
line lists the machine's own addresses instead. A bind that fails says which address it tried and what
to change.

The chat is the terminal's turn model: messages stream in, reasoning folds under its question, tool
lines appear as they run, a confirmation is an Allow/Deny card, `Enter` queues and `Ctrl+Enter` steers,
and `/` opens the command palette. Export and Clear sit in the top bar; sessions can be searched,
resumed and deleted. **Task lists** is a view of its own, showing the lists the `task_lists` tool keeps.

The **Panel** sits beside the chat: the `panel` tool shows a file there (a document or HTML you wrote,
a screenshot, a PDF — any type) or the **live browser** Milo is driving, which is also **interactive** —
click and type in it, which is where Milo hands over a login, a 2FA code or a payment it must not do
itself. Milo opens it when it has something to show ("here, look at this"). It holds **one tab per
thing**, per session: showing a second file does not take away the first, the strip at the top switches
between them and closes them, and Milo is told what is on the panel — so he can talk about a tab, or
read the file behind it, without being told where it is. The header's toggle folds the panel away, and
the tabs come back on reload. The browser streams only while its own tab is on screen.

**Settings** (the sidebar's last row) is `milo setup` in the browser — provider and model, API keys,
memory, routines, gateways, tools and the browser, permissions, display, skills and sessions. The long
setup jobs stream their output into a panel: the Chrome for Testing download, a profile copy, the local
embedding engine.

Two things to know before pointing a browser at it:

- **The frontend has to be built.** `npm run build:web` compiles `web/` into `web/dist`, which the
  server serves; after any change under `web/src` the served UI is stale until it is rebuilt.
- **The page may only come from a name the server answers to.** A request whose `Origin` names something
  else is refused.

### Routines

A prompt Milo runs on a timer and delivers to a chat, with nobody there when it fires. It opens its own
conversation, runs the prompt, and posts the answer to the chat you named. Made in chat, in your own
words — the `routine` tool turns the sentence into one and defaults the destination to the chat you
said it in, and the same tool lists them and moves, renames, pauses or removes one by its id — or on
the terminal:

```bash
milo routines add "look at the repo and tell me what moved" --name "daily briefing" \
  --at 08:00 --days mon-fri --gateway telegram --to 123456789
milo routines add "monthly report" --at 09:00 --day-of-month 1 --gateway telegram --to 123456789
milo routines add "deploy status" --every 6h --gateway discord --to 987654321
milo routines list
milo routines disable calm-otter-7
milo routines run calm-otter-7        # fire it now, printing the answer
milo routines remove calm-otter-7
```

Every routine has a **name**: the `--name` you give, or the first words of the prompt. The name leads
in `milo routines list` and signs the message in the chat. The id (`calm-otter-7`) is only for the
commands. The list is `~/.milo/routines.json`, editable by hand, reread on every tick, up to 50.

A routine's time is an interval (`every 30m`, `every 2h`) counted from the last run, or a wall-clock
time (`08:00`, `8h`) on the days, dates or months that allow it: days of the week (`--days mon-fri`,
`mon,wed,fri`, `1-5`), a day of the month (`--day-of-month 1,15`, `1-15`), or a month (`--month dec`,
`12`, `jul-set`). A month narrows the weekdays — `mon` in `jul` is every Monday in July — and a day of
the week is never combined with a day of the month. The time is an exact clock time: for "every so
often" use the interval. Times are **local**, and day and month names are read in English or
Portuguese and written back in English.

Three things to know before relying on one:

- **Only `milo serve` fires them**, and a time it slept through is **skipped, not caught up**.
- **Permission is decided when the routine is made, not when it fires.** Reading needs nothing; anything
  that writes, runs or sends a file is a standing grant it carries (`--allow shell_command,send_file`),
  confirmed at creation. At fire time a granted tool runs and anything else keeps the policy's answer —
  with nobody to ask, a refusal. An explicit deny still denies.
- **Each run is a new conversation** (`routine:<id>`), named after the routine, so it shows up in
  `/sessions` and is searchable.

The answer is posted at the target when the run finishes, split if long. A run can also deliver
**files**: `send_file` posts a file to the chat — a picture when it is an image, a document otherwise —
and the same tool works in any live chat, so *"screenshot the screen and send it"* is not only a
routine. A failure is posted too (`⚠ routine "…" failed: …`), a run still going when its next time
comes is skipped rather than stacked, and a routine cannot create routines.

## Tools

| Tool | Read-only | Notes |
| --- | --- | --- |
| `read_file` | yes | Line-numbered file contents; a long file comes back in pages. |
| `list_dir` | yes | One directory, not recursive. |
| `glob` | yes | Files matching a pattern, most recently modified first. |
| `grep` | yes | Regex over file contents, returning `path:line: text`. |
| `todo` | — | Keeps the plan for a multi-step task: a short checklist drawn on every surface. Updates only Milo's own display, so it never asks. |
| `task_lists` | — | Named task lists kept across every session and surface; only touches Milo's own state, so it never asks. |
| `git` | yes | Read a repository: `status`, `diff`, `log`, `show` and `blame`. |
| `git_commit` | no | Stage files (or every tracked change) and commit them; asks for confirmation. |
| `fetch_url` | yes | One http(s) URL, served back as text; a long page comes back in pages. |
| `write_file` | no | Creates or replaces a file; asks for confirmation. |
| `edit_file` | no | Exact string replacement; asks for confirmation. |
| `remember` | — | Saves a durable fact; only touches Milo's own memory, so it never asks. |
| `recall` | yes | Which past session a question is about, and what it was about. |
| `search_history` | yes | Term search over Milo's own past turns, reasoning and tool calls included. |
| `routine` | — | Runs a prompt on a timer and delivers it to a chat. Asks only when the routine carries a standing grant; absent inside a routine's own run. |
| `send_file` | no | Sends a file to the chat a turn is talking in — the live chat, or a routine's target — as a picture when it is an image. Asks; in a routine it needs a grant to run unattended. Not offered on the terminal, and its call is not drawn as a tool line. |
| `panel` | — | Shows a file or the live browser in the Panel beside the web chat, one tab per thing — the tab already holding something comes forward rather than a second copy of it. Only the web app draws a panel, so it is offered on that surface alone; its call is not drawn as a tool line. |
| `web_search` | yes | Registered only when a search provider is configured. |
| `read_skill` | yes | Loads a skill's instructions on demand; registered only when a skill is installed. |
| `gmail_search` | yes | Search the connected Gmail account; registered only when Google is on. `label:` reaches Gmail's own labels. |
| `gmail_read` | yes | One message in full, by the id `gmail_search` returned. |
| `gmail_modify` | no | Archive, mark read/unread, or move a message to the bin, by id. Needs the `modify` grant; asks before acting, and a routine must name it in `allow`. |
| `mail_labels` | — | Lists and edits Milo's own mail labels — local to `~/.milo/labels.json`, never written to Gmail — and says which messages carry one. Sorts mail to answer, so it is not read-only, but only touches Milo's own state, so it never asks. |
| `drive_search` | yes | Search the connected Drive. |
| `drive_read` | yes | One Drive file as text; Docs and Sheets come back exported. |
| `task` | — | Runs a subtask in its own context; only the report comes back. Only on request; never asks itself. |
| `browser_open` | yes | Opens an http(s) URL and returns the page as numbered elements. Only when the browser is on. |
| `browser_snapshot` | yes | The current page again: its elements, its text, or a picture of the viewport for the model. |
| `browser_screenshot` | no | A picture of the viewport written to a file, for the person. Asks, because it writes. |
| `browser_act` | no | Click, double-click, type, press, hover, scroll, choose, upload — and the page afterwards. |
| `shell_command` | no | Runs with `/bin/sh`; asks for confirmation first. |

Read-only tools never ask, so exploring is free: `glob` and `grep` replace the `ls`, `find` and `rg`
calls that would otherwise go through `shell_command` and its prompt. Both skip build output and
dependency directories (`node_modules`, `dist`, `build`, `target`, `.venv`, …); pass one of them as
`path` to search inside it. `grep` skips binary or oversized files and says how many.

The table is what Milo ships. Tools from an external server arrive the same way and are named
`mcp__<server>__<tool>` — see [MCP servers](#mcp-servers).

`read_file` cuts **between lines** and names what is left (`… 812 more line(s); continue with
offset=413`); a single line longer than the budget is clipped and says so. `fetch_url` returns the page
as text, cut at 40k characters with the offset that continues, and the next window is served from the
copy just read; a fresh read always goes to the network. Its body is read under a 5 MB ceiling, and
anything that is not text is refused with the content type it saw. What comes back is untrusted data:
the tool description tells the model to read it, not to obey it.

`write_file` and `edit_file` write through a temporary file and a rename, copying the target's
permissions first. `edit_file` replaces an exact string and **fails rather than guess**: an absent
string, or one that appears more than once without `replace_all`, is an error. It returns where it
landed (`at line 12`), not the file. A leading `~` is expanded in every tool. `shell_command` keeps the
**head and the tail** of a long output, since stderr comes last.

Anything with side effects goes through the permission policy in the core:

```yaml
permissions:
  mode: ask
  allow: [shell_command]
  deny: []
  jevThreshold: 0.35

classifier:
  backend: commandcode              # commandcode · openai · openrouter · ollaya · custom
  model: typesafe/jev               # absent → the backend's own default
  url: http://127.0.0.1:11435/v1    # ollaya/custom, or an OpenAI/OpenRouter base; the hosted jev rides on the provider
```

| Mode | Behavior |
| --- | --- |
| `ask` (default) | Read-only is allowed, `deny` blocks, everything else asks. |
| `auto` | Deterministic rules block the catastrophic cases first; the grey zone is reviewed by the configured decision model (`typesafe/jev` by default — see [Classifier](#classifier)) — below `jevThreshold` it runs, above it asks. Fails closed on reviewer errors and timeouts. |
| `yolo` | Everything runs, no prompts. |

`deny` beats everything except `yolo`. Read-only tools never ask, and neither does a tool whose only
side effect is on Milo's own state (`remember`, `todo`). On a surface that cannot ask, an `ask` decision **fails
closed**.

The deterministic rules cover two shapes, and only in `auto`: a catastrophic shell command (`rm -rf /`,
`mkfs`, a `curl … | sh`), and anything writing into a path that is never a legitimate target — a system
directory (`/etc`, `/usr`, `/bin`, `/boot`, …) or a credential store (`~/.ssh`, `~/.aws`, `~/.gnupg`,
`~/.netrc`). Both are refused outright. The second follows the *path*, not the tool, and reads the
command as text (redirections and the commands that take a path to write), which makes it a backstop,
not a sandbox. Everything else with side effects goes to the reviewer.

A confirmation shows what it is asking about: the target *and* the content (`- old` / `+ new` for an
edit), and the directory a command will run in when the call sets one. An `allow` entry is checked
before the rules, so `allow: ["shell_command"]` turns the backstop off for that tool.

Switch at runtime with `/mode ask|auto|yolo` or `/yolo`, from the terminal or a bot. The mode is
**saved** and is one value for every surface; `milo --mode`/`--yolo` are per-session overrides that
write nothing. A bot refuses `/mode`, `/yolo`, `/tools` and `/thinking` unless exactly one id is
allowed — one person must not be able to change the policy for the others.

### Classifier

The `auto` reviewer asks a **decision model**, not a chat model: one typed question, a calibrated
probability in a single forward pass, no generated text (`dangerous`, against `jevThreshold`).

- **`commandcode`** (default) — the hosted `typesafe/jev`, riding on the chat provider. It only exists
  where that provider is a Command Code one; anywhere else `auto` degrades to `ask`.
- **`openai`** — OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions), a
  hosted classifier asked with `gpt-6-luna` (the only model it serves today). It needs a key —
  `OPENAI_API_KEY`, or the same OpenAI key stored in `milo setup` — and stands on its own, independent
  of the chat provider. Defaults to `https://api.openai.com/v1`.
- **`openrouter`** — OpenRouter serves the same TypeSafe decision models (`liquid/d1`, `typesafe/jev`)
  over the same `/v1/systemone` wire, so it needs no wire of its own. Defaults to
  `https://openrouter.ai/api/v1` with `typesafe/jev-latest`, and to `OPENROUTER_API_KEY` (or the
  OpenRouter key stored in `milo setup`).
- **`ollaya`** — [Ollaya](https://ollaya.dev), a local runtime for open decision models
  (`ollaya serve`, then `backend: ollaya` and a model like `winnow:e4b`, or `laya` on a CPU). Same
  `/v1/systemone` wire, so nothing leaves the machine. Defaults to `http://127.0.0.1:11435/v1`.
- **`custom`** — any TypeSafe-compatible endpoint, named by `url` (with `keyEnv` for its key).

`model` names what to ask; left out, each backend uses its own default. A backend switch is read at
startup, so it takes effect on the next run (`milo setup` → **Classifier**, or the same fields under
Permissions in the web settings).

### Browser

A real Chromium over the DevTools protocol, driven through the page's own DOM — not a picture of a
browser and not a desktop.

It is **off until it is turned on** — `milo setup` → **Tools** → **Browser**, or
`"browser": { "enabled": true }`. Off means the three tools are not in the catalog at all.

**Any Chromium will do.** `milo setup` → Tools → Browser → **Browser to run** enumerates the favourites
— Chromium, Chrome, Brave, Edge, Vivaldi, Opera, and forks like Helium — from `PATH`, `/opt`, and each
platform's own places, de-duplicated. Firefox is not on that list: it speaks WebDriver BiDi.
`browser.chromePath` names a binary directly; when the machine has none, the same screen downloads a
[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) build into
`~/.milo/browser/chrome/` — an archive, no installer, no sudo.

**Three tools, split by side effect.** `browser_open` and `browser_snapshot` are read-only, so looking
around never asks. `browser_act` clicks, double-clicks, types, presses, hovers, scrolls, chooses and
uploads, and it is the one that asks. There is no `navigate` action inside it.

What the model is shown decides whether it picks the right element:

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

Not the HTML and not a screenshot: a role, a name and a state per element is enough for "click r7" to be
a complete instruction, and a screenshot carries no element identity.

A picture has to be asked for by name, and there are **two** because they are two different acts:

- `browser_snapshot` with `mode: "shot"` **reads** — the image goes back to the model. Read-only, so it
  never asks.
- `browser_screenshot` **writes** a picture to a path for the person. It asks, because writing to a path
  is what asking is for.

**A ref is good for one look**, and refs count **up across the session** rather than restarting at one,
so a ref held from an earlier look is simply absent. Every action already returns the page afterwards.

**Guardrails.** Milo starts a browser **of its own**, on `~/.milo/browser/profile/`, so sign-ins survive
a restart without the browser you actually use ever having remote debugging switched on. Attaching to
one already running is opt-in (`browser.cdpUrl`). Nothing on a page is an instruction. And
`browser_act` **refuses** to fill a password, card or one-time-code field.

**Reaching logged-in accounts.** `milo setup` → Tools → Browser → **Profile** copies the browser you are
signed into into `~/.milo/browser/profiles/<browser>/` (`browser.profileDir`), taking `Cookies`,
`Local State`, `Preferences` and the `Local Storage`/`IndexedDB` tokens live in, tightened to `0600` and
leaving every cache behind. It cannot share a profile you are browsing with — Chrome refuses to start
against a directory in use — and Chrome 136+ ignores `--remote-debugging-port` when the data directory
is the browser's own default, silently, so the setup screen flags that path in red. The route that needs
no copy is `browser.cdpUrl`: point it at a browser already running with remote debugging reachable (the
`chrome://inspect/#remote-debugging` checkbox), and Milo opens a tab in it.

```yaml
browser:
  enabled: true
  headless: true
  keepSnapshots: 2
```

`chromePath` names a binary instead of searching `PATH`, `profileDir` a profile instead of its own, and
`cdpUrl` attaches to a browser already running. `milo serve` adds `browser headless` or `browser off`
to its boot line. `keepSnapshots` is how many page snapshots ride in context; the older ones are
trimmed to the line that says what happened, before every request inside a turn.

### Display

How much of a turn you get to see is a per-install setting, not a per-surface one, so `/tools` typed in
Telegram applies to the terminal too. The bot gateways read it from disk on every turn, so a change
takes effect without restarting `milo serve`.

```yaml
display:
  tools: full
  thinking: on
```

A config that still says `true`, `false`, `brief` or `full` loads fine: anything that showed the
reasoning reads as `on`.

| Setting | Values | What it does |
| --- | --- | --- |
| `tools` | `full` (default) | The tool call with its arguments: `📄 read_file src/app.ts`. `shell_command` is drawn as its fenced block instead. |
| | `name` | Just which tool ran: `📄 read_file`. |
| | `off` | No tool lines at all. |
| `thinking` | `on` (default) | The reasoning is shown under the question it belongs to, and stays in the transcript. |
| | `off` | No reasoning at all. Display only — the model reasons either way. |

A tool that **fails** is reported whichever level is set (`❌ shell_command failed`), and the CLI stops
naming the tool in its status line when `tools` is `off`.

The reasoning lives **in the transcript**, under the question it belongs to, with the line saying how
long the model took to start (`✻ Thought for 8.2s`). A bot appends **one** line instead — `💭 the first
line of the thought` — because it edits a single message.

Thinking and answering are **two fields** on the wire: `content` for the answer, `reasoning_content` (or
`thinking`) for the thought. A provider is free to fill one field with both, and then no surface can
tell a model that answers in its thinking from one still thinking. Two rules follow:

- A turn that says **nothing in the answer channel** keeps all of its thinking — it is the answer,
  whatever channel it arrived in.
- `/thinking off` on such a model hides the answer with the thinking, so the turn **says so** instead of
  going quiet.

`MILO_DEBUG=1` prints what each response actually carried (`0 chars of content, 31 chars of reasoning,
finished tool_calls`). Each level that takes something away is visible in the CLI header
(`[tools name]`, `[thinking off]`), and the effort sits beside the model name (`effort medium` unless
changed). All three are in `/status` and in the **Display** section of `milo setup`.

### Reasoning effort

`/thinking` decides what you *see*; this decides what the model *does*. `reasoningEffort` (`low`,
`medium` or `high`, from `/effort` on any surface, `milo setup` → Display, or the config) is sent as
`reasoning_effort` on the OpenAI wire and mapped to a `thinking` token budget (`low` 1024, `medium`
2048, `high` 4096) on the Anthropic one. It **defaults to `medium`**: every request carries an explicit
effort. A provider that does not know the field ignores it; one that rejects it fails loudly on the
turn. On a bot that answers more than one person `/effort` is **locked**, like `/mode`.

```yaml
reasoningEffort: low
```

The **internal calls do not follow it**: summarizing a transcript and writing a recap ask for `low`
regardless, and if a provider does not know the field the call is made again without it.

On the Anthropic wire the signed thinking block is replayed ahead of the text and the tool call it
belongs to; a thought without a signature is dropped on the way out. The budget is only sent for the
turn itself, never for a mechanical call.

The terminal renders the answer as **light markdown**: fenced code blocks keep their code, inline code
and bold are styled, headings lose their hashes, and consecutive tool calls stack with no blank line
between them. Tables and nested lists are left as plain text. A bot trims a turn that outgrows the
message limit in the **middle**, keeping the beginning and the end. A command's reply is split into
whole messages instead — `/sessions` lists ten conversations with their recaps, which is more than one
message holds.

### Output limit

The Anthropic wire has a hard default of 4096 output tokens; OpenAI gets the provider's own default.

```yaml
maxTokens: 16384
```

Set `maxTokens` (or the **Output limit** row in `milo setup` → Display) to whatever the model really
supports; leave it out and each wire uses its own default. A turn that ends because of the limit says so
on both surfaces (`⚠ hit the output limit — the answer was cut off`).

### Web search

```yaml
search:
  provider: exa
```

Three providers behind one interface; `milo setup` → **Tools** → **Web search** picks one and asks for
its key.

| Provider | Free tier | Latency | What comes back |
| --- | --- | --- | --- |
| `tavily` | 1,000 credits/month, no card | ~450ms | Curated page content |
| `exa` | $20 on signup, then $10/month, no card | 180ms–1s (`fast` by default) | The passages relevant to the query, plus the page text |
| `parallel` | 5,000 requests/month, then $1 per 1,000 | ~700ms in `fast`, ~200ms in `turbo` | Dense excerpts from its own index |

The key comes from `TAVILY_API_KEY`, `EXA_API_KEY` or `PARALLEL_API_KEY`, or from `milo setup` → API
keys; each provider has its own slot in `auth.json`. Without a configured provider, `web_search` is
simply not registered.

### Google (Gmail & Drive)

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

### MCP servers

Milo can call tools that live outside it: any [MCP](https://modelcontextprotocol.io) server over
stdio. There is no SDK and no handshake library — the wire is hand-rolled, the same way the providers
are.

Servers are written in `~/.milo/mcp.json`, by hand, because a server *is* a command line:

```json
{
  "servers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/notes"],
      "readOnly": ["read_file", "list_directory"]
    }
  }
}
```

- `command`, `args`, `env`, `cwd` — what is launched, and where. `env` is added to Milo's own, and a
  `${VAR}` in a value is read from the environment, so a token stays out of the file. A variable that
  is not set is an error naming the field, not an empty value the server reads as "not authenticated".
- `enabled` — off keeps it out of the catalog without deleting what it took to set up, and stops its
  process.
- `readOnly` — the **server's** names for tools that only read. Those never ask; every other tool asks
  unless the permission policy says otherwise. A server's own `readOnlyHint` is deliberately ignored:
  an annotation is untrusted by the spec's own words, and a server does not get to answer the
  permission question about itself.
- `timeoutMs` — how long one call may take before it is abandoned (default 120000).
- A misspelled field is an error naming the ones that exist, and an invalid server name is an error
  too: the name becomes the prefix of every tool, so it takes single `_`/`-` separators only — a `__`
  would make `mcp__<server>__<tool>` ambiguous to read back.

Every server tool arrives as `mcp__<server>__<tool>`, and reads as `<server>: <tool>` on the surfaces,
with a 🔌 instead of the usual tool icon. Its description carries Milo's own line saying the tool comes
from an external server and that its output is untrusted data. The server's JSON Schema is sent to the
model **verbatim** — converted to Milo's own shape and back it would be Milo's reading of someone
else's contract.

**What it costs at startup is nothing.** There are three parts to that, and they are the design:

1. `~/.milo/mcp-cache.json` holds what each server last said its tools were, and the catalog is
   assembled from it — synchronously, before anything runs. The first turn has the tools the last run
   had, with no process and no round trip.
2. Connecting happens in the background, once per process, never awaited. An `npx` server that takes
   four seconds to boot is ready long before the person has finished typing.
3. A tool call dials if it has to. The connection is what a call waits for, which is where waiting
   belongs, and the tool line on every surface shows it running while it does.

`tools/list` is asked for once per connection, not once per turn; a `notifications/tools/list_changed`
re-lists and moves the catalog, taking a tool back out if the server dropped it. The era probe costs
one round trip on the first connect only: the cache remembers whether a server is modern
(`2026-07-28`, per-request metadata, `server/discover`) or legacy (`initialize` handshake), and a
wrong guess falls back to the probe.

```bash
milo mcp                    # the servers, and what the catalog holds from each
milo mcp check github       # connect now and list what it offers
milo mcp disable github     # out of the catalog, and its process stopped
milo mcp enable github
```

`check` is the verb that spawns servers, and it is where a failure is read in the server's own words —
including the last lines of its stderr. A server that will not start keeps its cached tools in the
catalog (they work again the moment it is back) and reports why in `milo mcp`, on the Tools screen of
the web settings, and in one `[milo]` line at startup. A server that dies mid-turn answers the call
with the failure instead of an empty result.

Milo speaks **stdio only** for now, and only the tools capability: resources, prompts and the
HTTP transport are not implemented, so a server configured for anything else has nothing to
call.

### Subagents

`task` hands a self-contained piece of work to a subagent: it runs the same loop with a **fresh
transcript** and returns only its final report. It is **on request only** — Milo does not delegate on
its own initiative. The subagent does not see the conversation and cannot ask anything, and it runs the
same tools as the parent **except `task` itself**, so a delegation is one level deep. `task` never asks
on its own, while every write or command the subagent attempts is put to the user the same way the
parent's would be; a `deny` entry for `task` blocks the delegation outright. Its own reads and searches
are not streamed — only the report comes back.

## Sessions

A conversation is a **session** with its own name (`calm-otter-7`), stored as one JSON file under
`~/.milo/sessions/`. The file is written on the session's **first turn**: a run that opens a
conversation and never speaks in it leaves nothing behind, so opening the CLI or the web UI does not
litter the directory. A transport address is only a **binding** to the session attached to it, so the
same session can be picked up from any gateway. Bindings live in `sessions/bindings/<scope>.json`, one
file per address. Two turns never run on one session at once: a turn takes a **lease** for as long as it
runs, so two terminals that both bind `cli:main` take turns. The record carries a **revision**, so a
save built from a stale copy is refused instead of overwriting a newer one.

| Command | What it does |
| --- | --- |
| `/new [title]` | Starts a fresh session and binds this conversation to it. |
| `/sessions` | Lists the saved sessions, most recent first. |
| `/resume <id>` | Binds this conversation to an existing session. |
| `/fork [id] [turn]` | Branches into a new session from this or a named one. |
| `/stats` | Name, timestamps, message/turn counts and context size for the current session. |
| `/clear` | Forgets the current session's transcript (destructive). |

In the terminal, `milo` begins a new conversation every time it opens, and the one you were in stays on
disk. `milo --continue` picks that one back up, and `milo --resume <id>` opens a specific one.
`sessions.maxSessions` (default 50) caps the directory: at startup the oldest sessions beyond it are
pruned, never one a scope is still bound to. Sessions nothing was ever said in are swept too, whatever
the cap and whatever is bound to them — an empty record holds nothing, and a leftover older Milo left
behind goes on the next launch. `0` lifts the cap. Pruning only trims the working transcript; the log
`recall` and `search_history` read is untouched.

Memory is keyed to the install, not the session or the conversation: a `/new` never changes what Milo
remembers. Leaving a session writes a short **recap** in the model's own words, kept out of the session
file in `sessions/recaps/<id>.json` and shown by `/sessions`. On Telegram and Discord, `/new`,
`/sessions` and `/resume` only work on a single-person bot (exactly one id in the allowlist).

### Task lists

The other thing that outlives a session. The `task_lists` tool keeps named checklists for the person —
`list`, `create`, `show`, `add`, `complete`, `remove`, `rename`, `delete` — in
`~/.milo/task-lists.json`, shared by every session and surface, so a list started in the terminal is
the one the web's **Task lists** view shows. It is Milo's own state, so it never asks; it is not the
`todo` checklist, which is the plan for the task at hand and lives only as long as that task.

### Compaction

Once a request passes `sessions.compactAt` **of the model's context window** (estimated at ~4 characters
per token), the oldest turns are summarized in one model call and replaced by an `## Earlier in this
conversation` section of the system prompt; the last `sessions.keepTurns` turns are kept verbatim. The
cut always lands on a user turn, so a tool call is never separated from its result. If the summary call
fails, the turns are dropped anyway.

```yaml
sessions:
  compactAt: 0.7
  keepTurns: 8
  compaction: true
```

The window comes from the OpenRouter catalog (`context_length` per model, no key), cached in
`~/.milo/context-windows.json` for a week; `sessions.contextWindow` overrides it, and `maxInputTokens`
is the fallback when nothing knows the window. The budget counts the **system prompt too**, and `/stats`
shows the count against the ceiling. When even the most recent turn plus the prompt is over the ceiling,
the summary is **not called at all**.

## History

Sessions are the working state; the **history log** outlives them — one append-only JSONL file per day
under `~/.milo/history/`, written `0600`, a line per event: every question, every answer, every tool
call with its arguments and result, and the model's reasoning, each tagged with the session's name and
the address it came from. A turn writes its lines in one `append`.

The reasoning is kept in the transcript and is not part of the conversation, so neither wire sends it
back — except the Anthropic wire, which signs its thinking blocks and requires them echoed once
thinking is on.

`search_history` is the read side: terms (all of them have to appear, any case), the newest matches from
the last 30 days, reading the reasoning, the tool arguments and the tool results. Pass `session` to stay
inside one conversation. Recall reads the log through an index bounded by `history.windowDays` (default
365; `0` keeps every day). The log itself is never trimmed on its own: `milo history` reports what it
holds, and `milo history trim --older-than <days>` (or `--before <date>`) deletes the days you name.

### Taking a conversation out

`/export` writes the current conversation to `~/.milo/exports/` — Markdown by default, `/export json` for
the entries themselves — and replies with the path, the counts and the size. It is the whole log: every
message, every tool call with its arguments and its **full** result, and the reasoning, in order. It
reads the **history log**, not the session's transcript, which is compacted and drops old screenshots. A
session with no turns exports nothing and says so.

`recall` answers the other half — not *what* was said but *which conversation* — ranking saved sessions
by how well their recap, title and first words match the query. `search_history` walks the day files;
recall runs before every turn and uses an index, `~/.milo/history/turns.db`, derived from those files
and rebuildable from them.

## Execution log

The history log holds *what was said*; the **execution log** at `~/.milo/traces.jsonl` holds *what it
cost* — one append-only JSONL file, a line per event, each with `at`, `event`, `ok` and `ms` plus its own
numbers. It never holds a prompt, an argument or an answer, so it is safe to keep and to read; that line
is the whole reason it can live beside the history.

Four events, each a closed name:

- `model.request` — one call to the chat model: `purpose` (`chat`, `task`, `compaction`, `recap`,
  `derive`), `model`, `provider`, `ttftMs` (time to the first token), `ms`, `inputTokens`, `outputTokens`,
  `finish`, and `surface`/`session` for a chat turn.
- `classifier.request` — the decision model: `purpose` (`danger`, `mail-labels`), `backend`, `model`,
  `cached`, and the typed answer it gave.
- `tool.call` — `tool`, `ms`, `ok` (no arguments).
- `turn` — the whole turn: `surface`, `session`, `model`, `ms`, `ok`.

Every model call goes through one seam (`Provider.stream`), so wrapping it once covers the chat turn, a
delegated subtask and the mechanical calls alike, from one measurement instead of counting the same span
at each caller. The classifier is a client of its own and is timed where it runs; the embedding engine
(run only when memory recall by meaning is on) is not logged yet.

The log is on by default (`traces.enabled`); `false` turns it off and nothing else changes. It is never
trimmed on its own — `milo log` reports what it holds (`status`), shows the last few events (`tail [n]`),
follows new ones live (`milo log -f [n]`, Ctrl+C to stop), and `milo log trim --older-than <days>` (or
`--before <date>`) drops the old ones.

## Memory

Memory sits behind a thin, vendor-agnostic interface (`remember` / `recall`). Milo's own store is **one
SQLite file** at `~/.milo/memory/memory.db`, written `0600`, searched with FTS5/BM25 — no account, no
key, no service, no network, and with the embedder off nothing you said leaves the machine. Third-party
backends (mem0, Honcho, Zep/Graphiti, Letta, Hindsight) plug in behind the same interface.

The store holds:

- **`fact`** — something worth keeping past the conversation: what `remember` saves, and what the end of
  a turn is read for. Nothing ever evicts one.
- **the turns themselves** — what the person typed, already in the history log and indexed from there by
  `turns.db`. One copy, in the artifact that outlives every session, `/clear` and compaction.

Recall reads the question as an FTS5 `MATCH` (words OR-ed, diacritics folded), reads facts first and
fills the rest of the reply with turns, so a durable note is not drowned by chatter. The same note saved
twice is one row; a turn collapses to the newest telling, with the verbatim history left in the log.
The `remember` tool is the deliberate half, and the end of a turn is read for facts as well.

### Recall by meaning, off by default

Words match words, so a note saying "editor" is not found by a question saying "IDE". An **opt-in**
embedding layer scores the same rows, and what it finds is added **after** what the words found, never
above it. There is deliberately **no similarity cutoff**. Two ways to get a model, both from
`milo setup` → **Memory**:

- **On this machine.** Milo downloads its own Ollama build into `~/.milo/embed`, checked against the
  published sha256, and starts it on a private port with `embeddinggemma` (593 MB); it dies with the
  Milo process. An engine Milo did not start is never touched.
- **On OpenRouter.** `nvidia/nemotron-3-embed-1b:free` by default, with the key from the same
  `auth.json` slot the chat models use. The notes leave the machine and its 512-token context truncates
  a long pasted turn.

Off by default, and it degrades rather than fails: with no `memory.embedding`, recall is BM25; an engine
that is down or refusing a note falls back to words with one log line. A note the model permanently
rejects (400/413/422) is set aside rather than retried.

### The old store

`memory.db` is the only backend. The first open **imports** whatever is in `~/.milo/memory/*.json` —
once, keeping each item's original timestamp, and skipping items the old store tagged `user`, which were
turns that live in the log — and then **leaves the JSON files where they are**. It also drops the copied
turns the store used to keep, and the `kind` column with them.

Recall is not the only thing that reaches the model, and the rest is untrusted by construction: a
remembered line, a compaction summary and `web_search` snippets all arrive fenced (`<memories>`,
`<summary>`) with a line saying they are data, not instructions.

`milo setup` → **Memory** shows what is actually in the store — facts, turns, size and where it lives,
with the recall-by-meaning line.

## Skills

A skill is a **procedure** the model can pick up on demand: a `SKILL.md` that says how to do something.
They live in one directory:

```
~/.milo/skills/<name>/SKILL.md
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

`name` is optional — the directory name is used when it is absent — but `description` is not: it is what
the model sees, so a skill without one is skipped.

Only the **index** — each skill's name and its one-line description — rides along with every request;
the instructions are loaded by the `read_skill` tool **only when a task matches**, and that tool is not
registered at all when no skill is installed. Skills are read once at startup, so adding one means
restarting `milo`; editing the body of one that exists does not, since the tool re-reads it per call.
`/skills` lists what was found.

`~/.milo/skills/` is created at startup and when `milo setup` opens its **Skills** section. The
directory is Milo's own; it does not read `~/.commandcode/skills`, though a symlink across is all it
takes to share them.

### Installing skills

`milo skills` is what fills that directory:

```bash
milo skills                 # what is installed
milo skills available       # the skills that ship with Milo
milo skills find [query]    # the most-installed in the directory
milo skills add <source>    # a local path, an http(s) URL, or owner/repo
milo skills remove <name>   # delete one
```

A `<source>` is a local directory holding a `SKILL.md`, a direct URL to one, `owner/repo` on GitHub, or
a **`skills.sh` page** (whose address encodes the same `owner/repo`, so a copied link installs). A
repository holding several skills makes you pick with `--skill <name>`. The same `SKILL.md` format is
what every other agent reads, so a skill from `npx skills` works here unchanged. `milo skills find`
reads the directory's ranking live, with each row's install count.

`milo setup` → **Skills** shows the same top five next to the bundled pair, each row with the repository
and install count plus the one-line summary. `Space` **picks** rows (several at once) and `Enter`
installs what was picked. If the page cannot be read the section says so and offers only what shipped
with Milo.

A few skills ship bundled (`milo skills available`) and are not written anywhere until you install one:
there is no enable flag, because *not installed* is what off looks like everywhere else in Milo.

A skill is instructions, not data, and cannot be fenced — being obeyed is the entire point of it — so
installing one from the open registry is closer to installing code than saving a note. The command shows
the name, description, source and size and asks before writing, nothing installs on its own, and **the
model has no tool that installs anything**.

## Development

```bash
npm run dev         # run the CLI from source (tsx)
npm run serve       # run the bot gateways and the web UI from source
npm run build:web   # build web/ into web/dist, which `milo serve` serves
npm run typecheck   # tsc --noEmit
npm run lint        # biome lint
npm test            # vitest
npm run build       # bundle to dist/ (tsup)
npm run bench:jev       # classifier latency (needs COMMANDCODE_API_KEY, or a local Ollaya)
npm run bench:browser   # what the browser toolset costs (needs a browser)
npm run bench:memory    # what recall costs
npm run eval:memory     # what recall gets right (add --semantic for the local engine)
npm run eval:mem0       # the same set through mem0, verbatim and with its pipeline
npm run check:browser   # that every verb in it works (needs a browser)
```

CI (`.github/workflows/ci.yml`) runs lint, types, tests with coverage and the build on every push and
pull request, plus a smoke run of the bundled binary. One trap worth knowing: with `NODE_ENV=production`
exported in your shell, npm treats every install as `--omit=dev` and **prunes the toolchain** — `tsc`,
`vitest` and `tsup` disappear. Recover with `npm ci --include=dev`.

### Source layout

- `src/core/` — the agent core, no UI or transport.
  - `providers/` — `Provider` interface + OpenAI/Anthropic adapters + wire factory.
  - `agent/` — the loop (`runAgent`), events, system prompt.
  - `tools/` — `Tool` interface, registry (zod → JSON Schema), built-in tools.
  - `search/` — `SearchProvider` plus the Tavily, Exa and Parallel adapters.
  - `memory/` — the `Memory` interface, the SQLite store (`sqlite.ts`), the coverage rule that trims a
    reply (`coverage.ts`), the JSON store it replaced (`local.ts`) and the one-time import
    (`migrate.ts`).
  - `skills/` — `SKILL.md` discovery, frontmatter parsing, and the loader behind the `read_skill` tool.
  - `mcp/` — the external tool servers: the hand-rolled JSON-RPC wire and its two eras, the stdio
    client, the listing cache the catalog is built from, and the manager that owns the processes.
  - `browser/` — the CDP client, finding and starting Chrome, copying a profile out of another browser,
    the page observer, and the three tools.
  - `google/` — the OAuth flow, the token source the tools read, and the Gmail and Drive clients.
  - `sessions/` — `SessionStore` interface + `FileSessionStore` / `MemorySessionStore`, the recaps kept
    out of a transcript (`RecapStore`) and their ranking (`rankSessions`), nickname generation,
    compaction (`estimateTokens` / `planCut` / `planCutUnderBudget` / `summarize`), retention
    (`pruneSessions`) and `/stats` formatting.
  - `config/` — paths, zod schema, presets, load/save, onboarding wizard.
  - `runtime.ts` / `session.ts` / `bootstrap.ts` / `history.ts` (the log and its readout) /
    `traces.ts` (the execution log).
- `src/gateways/` — `cli/` (Ink), `telegram/` (grammY), `discord/` (discord.js) and `web/` (the HTTP +
  WebSocket server, the hub that drives turns, the settings actions and the job registry).
- `web/` — the browser frontend (React + Vite), built into `web/dist` and served by `src/gateways/web/`.
- `src/bin/` — `cli.ts` (`milo`), `serve.ts` (`milo serve`), `web.ts` (`milo web`), and the plain
  terminal commands `skills.ts` (`milo skills`), `history.ts` (`milo history`), `log.ts` (`milo log`),
  `routines.ts` (`milo routines`) and `google.ts` (`milo google`).

## License

MIT — see [LICENSE](LICENSE).
