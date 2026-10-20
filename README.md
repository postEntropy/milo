<div align="center">
  <img src="assets/milo-mark.png" alt="Milo" width="190">
</div>

# Milo

[![CI](https://github.com/postEntropy/milo/actions/workflows/ci.yml/badge.svg)](https://github.com/postEntropy/milo/actions/workflows/ci.yml)

A multi-surface agent — one transport-agnostic **core** with pluggable **gateways**, pluggable **LLM
providers**, a pluggable **memory** layer and durable **sessions**. Milo is built around three surfaces:
the **terminal**, the **browser** and the **iPhone**; the **Telegram** and **Discord** bots are optional
and ride the same core. Hand-rolled LLM layer (no provider SDKs), built for a fast boot and immediate
token streaming.

```
GATEWAYS   CLI (Ink)        Web (React)        iOS (SwiftUI)
               └─────────────────┴───────────────────┘
           Telegram (grammY) · Discord (discord.js)   optional bots
CORE       AgentRuntime → Session → AgentLoop   +  Tools · Memory · Providers · Config · Routines
PROVIDERS  Command Code Provider API · OpenCode Zen · OpenRouter · OpenAI · Anthropic · Ollama · custom
```

The core never knows about Ink, a browser, a phone, Telegram or Discord: it hands each gateway a stream
of normalized `AgentEvent`s, and the gateway translates input in and events out.

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
  line history, a different thing from the turn log the model can search (see [History](docs/history.md)).
- `/new`, `/resume`, `/fork`, `/clear`, `/model`, `/provider`, `/setup` and `/compact` are refused while a
  turn runs.
- A turn that takes a second or more to produce output shows `✻ Thought for 8.2s` — or
  `✻ Thought for 12s (4.2s compacting)` when a summary call ran first — measured from the question to
  the first visible output.

## Configuration

- `~/.milo/config.yml` — provider, model, `maxTokens`, reasoning effort, memory, sessions, traces,
  display, permissions, browser, the web UI, enabled gateways and the verification gate. YAML so it can
  carry comments; every surface rewrites it, and a line you add survives any write that does not touch
  the key above it.
- `~/.milo/rules.yml` — permission rules for shell commands, hand-edited
  (see [Rules file](docs/tools.md#rules-file)). A project may add `<project>/.milo/rules.yml`; its rules
  are read first.
- `~/.milo/AGENTS.md` — the install's own rules, above every project's and carried in every session
  (see [The agent](docs/agent.md#what-a-turn-is-told)).
- `~/.milo/auth.json` — API keys, bot tokens and the Google grant (`0600`).
- `~/.milo/input-history.json` — what was typed at the CLI's prompt, for `↑`/`↓`.
- `~/.milo/projects.json` — the folders Work lists, each an id, a name and a path
  (see [Work](docs/work.md)).
- `~/.milo/task-lists.json` — the named task lists, shared by every session
  (see [Task lists](docs/sessions.md#task-lists)).
- `~/.milo/routines.json` — the prompts Milo runs on a timer (see [Routines](docs/routines.md)).
- `~/.milo/labels.json` — the mail labels Milo sorts with, never written back to Gmail;
  `mail-seen.json` is the sidebar badge's watermark (see [Google](docs/google.md#google)).
- `~/.milo/mcp.json` — the external tool servers, hand-edited (see [MCP servers](docs/mcp.md#mcp-servers)).
- `~/.milo/mcp-cache.json` — what each MCP server last said its tools were. Derived: deleting it costs
  one round trip.
- `~/.milo/sessions/` — one JSON file per session, one binding file per address, one recap per session
  left behind (see [Sessions](docs/sessions.md#sessions)).
- `~/.milo/memory/` — the memory store, `memory.db` (SQLite) (see [Memory](docs/memory.md#memory)).
- `~/.milo/history/` — the log: one JSONL per day, plus `turns.db`, its index.
- `~/.milo/traces.jsonl` — the execution log: one line per model request, classifier, tool and turn,
  with its latency (see [Execution log](docs/history.md#execution-log)).
- `~/.milo/models.json` — the model profiles the context window and capabilities come from, cached for
  a week.
- `~/.milo/jobs/` — the background jobs' output and state, kept after they end.
- `~/.milo/devices.json` — the phones paired with this Milo, each token kept hashed; `pairing.json` is
  the one open code.
- `~/.milo/skills/` — one `<name>/SKILL.md` per skill (see [Skills](docs/skills.md#skills)).
- `~/.milo/browser/` — the browser's own profile (`profile/`), a downloaded Chrome (`chrome/`) and
  profiles copied out of a browser you use (`profiles/`) — not the browser you use (see
  [Browser](docs/browser.md#browser)).
- `~/.milo/exports/` — sessions written out by `/export` (`0600`).

A corrupt `config.yml` is reported at startup; the settings a running session changes read it
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

The **CLI** is always available. The **web** and the **iPhone** are clients of one daemon: `milo serve`
runs the HTTP + WebSocket server both talk to, so a phone paired to it (see [iOS](#ios)) draws the same
sessions, tools and memory as the browser. The **Telegram** and **Discord** bots are optional — off
unless you turn them on — and are that same core reached one more way.

A session can be pointed at a registered project, so its tools and its prompt work in that
folder: `milo --project <id|name|folder>` opens the chat there, and `--cwd <folder>` does the
same for a folder that is not in the list.

### One turn, no chat

`milo run` is the terminal's headless turn: the prompt in, the answer out, and an exit code
that says whether it finished. It is what a script or a cron job calls.

```bash
milo run "what changed in this repo today?"
milo run --project milo "run the tests and say what failed"
milo run --json --allow shell_command "npm test"   # one JSON event per line
echo "summarize the open TODOs" | milo run
```

With nobody to ask, a tool that needs confirmation fails rather than waiting. A headless run
is given what it may do with `--mode auto|yolo` and `--allow tool,…`; `--session <id>` and
`--continue` reach a session that already exists. With `verification.enabled`, a turn that
wrote runs the project's own checks, and the exit code is 1 when they fail.

## Web

A browser chat, on the same core, sessions and memory — and the server the phone talks to as well (see
[iOS](#ios)). It is served by `milo serve`, so a daemon already keeping the bots up also opens the URL
it prints:

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
**Work** is the code workspace: the registered projects, one project's sessions, its files, its git
changes and its rules, with a session started in that folder (see [Work](docs/work.md)). **Email** is
the connected inbox — read, search, label, summarize and answer, as far as the Google grant allows
(see [Google](docs/google.md)).

The **Panel** sits beside the chat: the `panel` tool shows a file there (a document or HTML you wrote,
a PDF — anything meant to be read beside the chat; a screenshot or any picture goes to the chat
instead) or the **live browser** Milo is driving, which is also **interactive** —
click and type in it, which is where Milo hands over a login, a 2FA code or a payment it must not do
itself. Milo opens it when it has something to show ("here, look at this"). It holds **one tab per
thing**, per session: showing a second file does not take away the first, the strip at the top switches
between them and closes them, and Milo is told what is on the panel — so he can talk about a tab, or
read the file behind it, without being told where it is. The header's toggle folds the panel away, and
that is remembered: Milo opens the panel when it shows something, not when a session is opened, so a
reload brings the tabs back folded unless you keep it open. The browser streams only while its own tab
is on screen.

**Settings** (the sidebar's last row) is `milo setup` in the browser — provider and model, API keys,
memory, gateways, the web server, tools and the browser, permissions, display, skills and sessions.
The long setup jobs stream their output into a panel: the Chrome for Testing download, a profile copy,
the local embedding engine.

One thing to know before pointing a browser at it:

- **The frontend has to be built.** `npm run build:web` compiles `web/` into `web/dist`, which the
  server serves; after any change under `web/src` the served UI is stale until it is rebuilt.

## iOS

The phone is a native client of the same daemon, not a second backend. It reaches the very web gateway
the browser does and names its own kind in the handshake — `ios` — which is what tells the two apart,
and what makes a turn it starts a phone turn (`surfaceOf`, `src/core/session.ts`). So the sessions,
tools, memory, routines and settings are the install's own, seen from a pocket. The app is SwiftUI on
iOS 26 (Liquid Glass), lives in `ios/`, and reads the browser's wire
(`src/gateways/web/protocol.ts`); the two halves it can test without a device — the connection state
machine and the generated-interface arithmetic — are their own packages (`ios/Connection`,
`ios/GenUi`).

It is built and installed straight onto the device over the network with **xtool**; there is no
simulator and no Xcode project to open:

```bash
cd ios
xtool dev build   # compile the app here — the check that runs anywhere
xtool dev run     # build, install and launch it on the phone
```

`xtool dev build` is the check this machine can run; `xtool dev run` onto the device is the only proof
of the look, since the drawing is the phone's to settle.

What it draws, the way the browser does: **Chat** streams a turn — reasoning folded under its question,
one line per tool call with the result folded underneath, an Allow/Deny card and its countdown for a
confirmation, the queued count, and steer, queue and stop on the send control. A message can be edited
and said again, and a session's own id copied. **Sessions** is a drawer that reads the list afresh and
starts a new session; the **model picker** is searched by slug, display name and the daemon's shortened
label. **Routines** is a page of its own — run one now, pause or remove it, and read its run history as
the same thread the chat draws — with a **local reminder** set at each routine's next fire times,
because a closed phone cannot be reached any other way. **Task lists** is a page of its own, showing the
lists the `task_lists` tool keeps, and **Work** draws the projects, a folder's files, changes and rules,
and starts a session there. **Settings** draws the install's own — the model, the theme and the GenUI
toggle, memory, tools and web search, the skills, the MCP servers, the permission mode, the
connections, the reply notice, the daemon and Unpair. The **Panel** sits beside the chat: the `panel`
tool shows a document, a PDF, an HTML page or the **live browser** Milo is driving, and it is
interactive — which is where Milo hands over a login, a 2FA code or a payment it must not do itself.
A picture is the chat's, not the panel's. The phone draws a **generated interface** (the `genui` fence
in an answer) too, being one of the two surfaces that can (`canDraw`, `src/core/session.ts`).

The phone's own notices: **Notify when Milo replies** raises a local banner carrying the first of the
answer's words when the chat is not what is on screen, and a tap opens the session the notice names. A
send asks the system for a **continued task**, which keeps Milo on a slow answer past the screen for
minutes instead of the ~30 seconds a plain background hold buys; the system draws its own progress for
it and can end it under pressure. A real push would need an Apple Developer account and an APNs server,
so an answer that outlives even that is read on return, with no banner.

`milo serve --no-web` closes the phone's door with the browser's: the phone is a client of that server
and of nothing else. What it still lacks against the browser — session search and clear, the Email and
Google screens, and the settings the browser still has over it — has not been built yet.

### Pairing a phone

A browser you opened yourself holds the token in its URL. A phone is a different client, and is given
an identity of its own. `milo pair` opens a six-digit code — good for two minutes, used once — and
prints it **as a QR** (and in words, for a phone that cannot scan) with the addresses the machine
answers on; the app scans it (`ios/Sources/Milo/Screens/QRScanner.swift`) and redeems it at
`POST /pair/claim`, and is handed a token of its own, kept **hashed** in `~/.milo/devices.json` (`0600`),
never in the clear. That token opens the same gate the install's own does, and taking it back closes only
that device:

```bash
milo pair                  # print a QR and a code to give the app
milo devices               # the devices paired with this Milo
milo devices revoke <id>   # take one back — its token stops working at once
```

The QR is drawn here rather than by a package: `src/core/qr.ts` is the one symbol the product needs
(byte mode, level M, versions 1–6), and `test/qr.test.ts` checks it against structure and a
round-trip. A phone reaches the daemon over the network, so `web.host` has to name an address it can
use — the machine's tailnet or LAN one, or `0.0.0.0` — and not the loopback default; the QR is only
drawn when there is such an address. The daemon speaks plain http and ws, so the encryption is the
tailnet the phone and the machine already share, and `Info.plist` is what lets the app reach it by
address. `/pair/claim` is the one route that answers without a token; the code is what it spends
instead, and the tries are capped per address. The open code is written to `~/.milo/pairing.json`, which
is why the terminal that prints it and the daemon that redeems it can be two processes.

## Telegram & Discord (optional)

The bots are the same core reached from a chat app. `milo setup` → **Gateways** toggles them and stores
the tokens, or edit `~/.milo/config.yml`:

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

Each chat maps to its own session (`telegram:<chatId>`, `discord:<channelId>`), while what Milo
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

Commands typed in the chat: `/help`, `/new`, `/sessions`, `/resume`, `/fork`, `/stats`, `/jobs`,
`/compact`, `/export`, `/skills`, `/memory`, `/mode ask|auto|yolo`, `/yolo`, `/tools full|name|off`,
`/thinking expanded|collapsed`, `/effort low|medium|high`, `/provider [id]`, `/model [id]`, `/clear`,
`/status`.
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

## Documentation

The deep reference lives in `docs/`:

| Document | What it covers |
| --- | --- |
| [Tools](docs/tools.md) | The tool catalog, the permission policy and its modes, the classifier, web search and subagents. |
| [Browser](docs/browser.md) | The Chromium toolset: how it starts, what the model is shown, and the guardrails. |
| [Google](docs/google.md) | Gmail and Drive — connecting, the access levels, and what each tool may do. |
| [MCP servers](docs/mcp.md) | Calling tools that live in an external server, over stdio. |
| [Routines](docs/routines.md) | Prompts Milo runs on a timer and delivers to a chat. |
| [Sessions](docs/sessions.md) | Sessions, task lists and compaction. |
| [Work](docs/work.md) | Projects, a folder's files, changes and rules, and Plan/Build. |
| [The agent](docs/agent.md) | What a turn is told: persona, family, code manual, rules and verification. |
| [History](docs/history.md) | The history log, taking a session out, and the execution log. |
| [Memory](docs/memory.md) | The store, recall by meaning, and the migration off the old JSON store. |
| [Skills](docs/skills.md) | The `SKILL.md` procedure format and installing skills. |
| [Development](docs/development.md) | Running from source, the checks, and the source layout. |

## License

MIT — see [LICENSE](LICENSE).
