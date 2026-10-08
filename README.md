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
  line history, a different thing from the turn log the model can search (see [History](docs/history.md)).
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
- `~/.milo/task-lists.json` — the named task lists, shared by every session (see [Task lists](docs/sessions.md#task-lists)).
- `~/.milo/mcp.json` — the external tool servers, hand-edited (see [MCP servers](docs/mcp.md#mcp-servers)).
- `~/.milo/mcp-cache.json` — what each MCP server last said its tools were. Derived: deleting it costs
  one round trip.
- `~/.milo/sessions/` — one JSON file per session, one binding file per address, one recap per session
  left behind (see [Sessions](docs/sessions.md#sessions)).
- `~/.milo/memory/` — the memory store, `memory.db` (SQLite) (see [Memory](docs/memory.md#memory)).
- `~/.milo/history/` — the log: one JSONL per day, plus `turns.db`, its index.
- `~/.milo/traces.jsonl` — the execution log: one line per model request, classifier, tool and turn,
  with its latency (see [Execution log](docs/history.md#execution-log)).
- `~/.milo/skills/` — one `<name>/SKILL.md` per skill (see [Skills](docs/skills.md#skills)).
- `~/.milo/browser/` — the browser's own profile (`profile/`), a downloaded Chrome (`chrome/`) and
  profiles copied out of a browser you use (`profiles/`) — not the browser you use (see
  [Browser](docs/browser.md#browser)).
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
that is remembered: Milo opens the panel when it shows something, not when a session is opened, so a
reload brings the tabs back folded unless you keep it open. The browser streams only while its own tab
is on screen.

**Settings** (the sidebar's last row) is `milo setup` in the browser — provider and model, API keys,
memory, routines, gateways, tools and the browser, permissions, display, skills and sessions. The long
setup jobs stream their output into a panel: the Chrome for Testing download, a profile copy, the local
embedding engine.

Two things to know before pointing a browser at it:

- **The frontend has to be built.** `npm run build:web` compiles `web/` into `web/dist`, which the
  server serves; after any change under `web/src` the served UI is stale until it is rebuilt.
- **The page may only come from a name the server answers to.** A request whose `Origin` names something
  else is refused.

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
| [History](docs/history.md) | The history log, taking a conversation out, and the execution log. |
| [Memory](docs/memory.md) | The store, recall by meaning, and the migration off the old JSON store. |
| [Skills](docs/skills.md) | The `SKILL.md` procedure format and installing skills. |
| [Development](docs/development.md) | Running from source, the checks, and the source layout. |

## License

MIT — see [LICENSE](LICENSE).
