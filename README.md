<div align="center">
  <img src="assets/milo.jpeg" alt="Milo" width="190">
</div>

# Milo

A multi-surface agent — one transport-agnostic **core** with pluggable **gateways** (CLI, Telegram,
Discord), pluggable **LLM providers**, a pluggable **memory** layer and durable **sessions**.
Hand-rolled LLM layer (no provider SDKs), built for a fast boot and immediate token streaming.

```
GATEWAYS   CLI (Ink)      Telegram (grammY)      Discord (discord.js)
              └────────────────┴────────────────────────┘
CORE       AgentRuntime → Session → AgentLoop   +  Tools · Memory · Providers · Config
PROVIDERS  Command Code Provider API · OpenRouter · OpenAI · Anthropic · Ollama · custom
```

The core never knows about Ink, Telegram or Discord. It hands each gateway a stream of normalized
`AgentEvent`s; gateways translate user input in and events out.

## Requirements

- Node.js >= 20 (developed on 26)
- An API key for one provider (or a local Ollama), for conversational use

## Install & run

```bash
npm install
npm run dev            # start the interactive CLI chat
npm run dev -- --model deepseek/deepseek-v4-flash   # override the model for one session
```

On the first run, an onboarding wizard asks for a provider, API key, and model, and saves them to
`~/.milo/`.

## Configuration

- `~/.milo/config.json` — provider, model, memory backend, session settings, enabled gateways.
- `~/.milo/auth.json` — API keys and bot tokens (written `0600`).
- `~/.milo/sessions/` — one JSON file per session, plus the address bindings (see below).

Environment variables override stored secrets: `COMMANDCODE_API_KEY`, `OPENROUTER_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`.
Set `MILO_HOME` to relocate `~/.milo`; set `MILO_DEBUG=1` to log memory `remember`/`recall` calls.

### Providers

| Preset | Endpoint | Wire |
| --- | --- | --- |
| `commandcode` | `https://api.commandcode.ai/provider/v1` | auto (Claude → `/messages`, others → `/chat/completions`) |
| `openrouter` | `https://openrouter.ai/api/v1` | OpenAI |
| `openai` | `https://api.openai.com/v1` | OpenAI |
| `anthropic` | `https://api.anthropic.com/v1` | Anthropic |
| `ollama` | `http://localhost:11434/v1` | OpenAI (no key) |

The Command Code Provider API needs a plan above Go (GOAT/Pro/Max/Team or the Provider plan), and
uses the same API key as the CLI (Studio → API keys).

## Gateways

The CLI is always available. The bot gateways run as a daemon:

```bash
milo setup                 # Gateways section toggles them and stores the tokens
# or edit ~/.milo/config.json:
{ "gateways": { "telegram": { "enabled": true }, "discord": { "enabled": true } } }
```

```bash
export TELEGRAM_BOT_TOKEN=...
export DISCORD_BOT_TOKEN=...
npm run serve
```

Each conversation maps to its own session and memory scope (`telegram:<chatId>`,
`discord:<channelId>`). Replies stream by editing one message; tool activity is grouped into blocks —
a **code block** for shell commands, with the command itself, and a **quote box** for searches and
file reads. On Telegram the answer goes out as a **rich message** (Bot API 10.1+), so Markdown
renders — headings, lists, tables, code blocks — falling back to plain text if the API refuses it.
For Discord, enable the **Message Content** privileged intent in the Developer Portal.

Tool confirmations arrive as **inline buttons** (Telegram) or **buttons** (Discord) — the turn
waits for the press and fails closed after five minutes.

### Who can talk to the bot

By default a bot answers anyone who finds it. Give it an `allowlist` to close that down:

```json
{ "gateways": { "telegram": { "enabled": true, "allowlist": ["123456789"] } } }
```

An entry matches either the sender's **user id** or the **conversation id** (chat, channel or
guild), so you can allow one person or a whole room. An empty list means anyone; a non-empty list
fails closed for everyone else, and a blocked sender is told their own id so you can add it.
`milo setup` → Gateways walks through token → access → enable. The allowlist is read when
`milo serve` starts, so restart it after changing it.

Commands typed in the chat: `/help`, `/new`, `/sessions`, `/resume`, `/stats`, `/mode ask|auto|yolo`,
`/yolo`, `/clear`, `/status`. A mode change from a chat is written to `config.json` like any other,
so it survives a restart of `milo serve`; sessions are written to `~/.milo/sessions/` and survive it
too. Provider and key changes happen in `milo setup` on the terminal side.

Both bots are thin shells over one transport-agnostic runner (`src/gateways/runner.ts`) plus a
`ChatSurface` interface, so the turn logic — streaming, tool lines, permission routing, truncation
— is shared and unit-tested against a fake surface. The library glue (grammY / discord.js calls)
is the part that only a real token can exercise.

A gateway must hand each turn to its `TurnQueue` instead of awaiting it in the update handler. A
turn blocks until the user answers a permission prompt, and Telegram's simple long polling handles
updates one at a time (`handleUpdates` awaits each one), so awaiting a turn there would leave the
button press queued behind the very turn waiting for it — a deadlock that ends in a timeout and a
denied tool. The queue also stops two turns from mutating the same session at once.

## Tools

| Tool | Read-only | Notes |
| --- | --- | --- |
| `read_file` | yes | Line-numbered file contents. |
| `web_search` | yes | Registered only when a search provider is configured. |
| `shell_command` | no | Runs with `/bin/sh`; asks for confirmation first. |

Anything with side effects goes through the permission policy in the core:

```json
{
  "permissions": {
    "mode": "ask",
    "allow": ["shell_command"],
    "deny": [],
    "jevThreshold": 0.35,
    "jevTimeoutMs": 1500
  }
}
```

| Mode | Behavior |
| --- | --- |
| `ask` (default) | Read-only is allowed, `deny` blocks, everything else asks. |
| `auto` | Deterministic rules block the catastrophic cases first; the grey zone is reviewed by `typesafe/jev` — below `jevThreshold` it runs, above it asks. Fails closed on reviewer errors and timeouts. |
| `yolo` | Everything runs, no prompts. |

`deny` beats everything except `yolo`. Read-only tools never ask. On a surface that cannot ask
(a bot gateway with no confirmation UI yet) an `ask` decision **fails closed**.

Switch at runtime with `/mode ask|auto|yolo` or `/yolo` — from the terminal or from a bot. The mode
is **saved** whenever a command changes it, and it is one value for every surface: a `/mode` typed in
Telegram also applies to the next terminal session. `milo --mode`/`--yolo` are per-session overrides
and write nothing, so a one-off `--yolo` does not stick. The header shows the active mode whenever it
is not `ask`.

A bot refuses `/mode` and `/yolo` unless exactly one id is allowed. With several people — or with an
open bot, where anyone who finds it can talk — one of them must not be able to turn off confirmation
for the others; the reply says so and points at `milo setup`.

The `auto` reviewer only exists where the decision model does — a Command Code provider. Anywhere
else, `auto` degrades to `ask`.

### Measuring jev latency

The reviewer sits in the hot path, so latency matters:

```bash
npm run bench:jev          # needs COMMANDCODE_API_KEY (or CMD_API_KEY)
RUNS=10 npm run bench:jev
```

It prints p50/p95 latency and P(dangerous) per sample command. Identical commands are served from
an in-memory LRU, so a repeated command costs nothing; a request that exceeds `jevTimeoutMs` is
aborted and falls back to asking.

### Web search

```json
{ "search": { "provider": "exa" } }
```

Three providers behind one interface; `milo setup` → Web search picks one and asks for its key.

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

## Sessions

A conversation is a **session** with its own name (`calm-otter-7`), stored as one JSON file under
`~/.milo/sessions/`. The transport address — a Telegram chat, a Discord channel, the CLI — is only
a **binding** to the session currently attached to it (`bindings.json`), so the same session can be
picked up from any gateway.

| Command | What it does |
| --- | --- |
| `/new [title]` | Starts a fresh session and binds this conversation to it. |
| `/sessions` | Lists the saved sessions, most recent first. |
| `/resume <id>` | Binds this conversation to an existing session. |
| `/stats` | Name, timestamps, message/turn counts and context size for the current session. |
| `/clear` | Forgets the current session's transcript (destructive). |

In the terminal, `milo` continues the last session bound to the CLI, and `milo --resume <id>` opens
a specific one (`milo --continue` is the explicit form of the default).

Memory is keyed by the conversation, not the session, so facts you told Milo before a `/new` are
still available afterwards.

On Telegram and Discord, `/new`, `/sessions` and `/resume` only work on a single-person bot (exactly
one id in the allowlist). On a shared or open bot they are locked, so nobody can switch into someone
else's sessions.

### Compaction

A long session would otherwise hit the model's context limit. Once the transcript passes
`sessions.maxInputTokens` (estimated at ~4 characters per token), the oldest turns are summarized in
one model call and replaced by an `## Earlier in this conversation` section of the system prompt; the
last `sessions.keepTurns` turns are kept verbatim. The cut always lands on a user turn, so a tool
call is never separated from its result. If the summary call fails, the turns are dropped anyway — a
request that fits beats one the provider rejects.

```json
{ "sessions": { "maxInputTokens": 12000, "keepTurns": 8, "compaction": true } }
```

## Memory

Memory sits behind a thin, vendor-agnostic interface (`remember` / `recall`). The MVP ships a
local `FileMemory` (JSON per conversation scope, keyword + recency retrieval). Third-party backends
(mem0, Honcho, Zep/Graphiti, Letta, MemPalace, Hindsight) plug in behind the same interface later —
nothing in the agent calls a vendor SDK directly.

## Skills / development

```bash
npm run dev         # run the CLI from source (tsx)
npm run serve       # run the bot gateways from source
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # bundle to dist/ (tsup)
```

### Source layout

- `src/core/` — the agent core, no UI or transport.
  - `providers/` — `Provider` interface + OpenAI/Anthropic adapters + wire factory.
  - `agent/` — the loop (`runAgent`), events, system prompt.
  - `tools/` — `Tool` interface, registry (zod → JSON Schema), built-in tools.
  - `search/` — `SearchProvider` plus the Tavily, Exa and Parallel adapters.
  - `memory/` — `Memory` interface + `FileMemory`.
  - `sessions/` — `SessionStore` interface + `FileSessionStore` / `MemorySessionStore`, nickname
    generation, compaction (`estimateTokens` / `planCut` / `summarize`) and `/stats` formatting.
  - `config/` — paths, zod schema, presets, load/save, onboarding wizard.
  - `runtime.ts` / `session.ts` / `bootstrap.ts`.
- `src/gateways/` — `cli/` (Ink), `telegram/` (grammY), `discord/` (discord.js).
- `src/bin/` — `cli.ts` (`milo`), `serve.ts` (`milo serve`).

## Roadmap

Known open work, roughly in order:

1. **Live verification of the bot gateways.** The Telegram and Discord glue is only exercised
   against fakes, so a real token is still needed to confirm the permission buttons, the rich
   messages and the turn queue against the live APIs.
2. **A real memory backend** (mem0 / Honcho / Zep / Letta / Hindsight) behind the same
   `remember` / `recall` interface. Today: keyword overlap plus a recency bonus, over what the user
   said only.
3. **Memory across gateways.** Facts are keyed by the conversation address, so something told in
   Telegram is not visible in the CLI. Sharing them needs a per-person identity map.
4. **Web search needs a key.** `config.json` has no `search` section, so `web_search` is not even
   registered right now. The Exa and Parallel adapters exist but have never been called for real.
5. Markdown rendering in the Ink UI (the terminal shows plain text; only the bots get rich messages).
6. `milo setup` on a fresh install runs the onboarding wizard and exits, instead of continuing into
   the settings hub.
