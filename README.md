<div align="center">
  <img src="assets/milo.jpeg" alt="Milo" width="190">
</div>

# Milo

[![CI](https://github.com/postEntropy/milo/actions/workflows/ci.yml/badge.svg)](https://github.com/postEntropy/milo/actions/workflows/ci.yml)

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

`Ctrl+C` stops the turn in flight — the partial answer stays in the transcript and the turn is
reported as *stopped*, not as an error, because a stop is the user's own doing. Pressed with nothing
running, it exits.

## Configuration

- `~/.milo/config.json` — provider, model, `maxTokens`, memory backend, session settings, display,
  permissions and enabled gateways.
- `~/.milo/auth.json` — API keys and bot tokens (written `0600`).
- `~/.milo/sessions/` — one JSON file per session, plus one binding file per address (see below).
- `~/.milo/memory/` — one JSON file per conversation scope.

A corrupt `config.json` is reported at startup rather than swallowed, but the settings a running
conversation changes (`/mode`, `/tools`, `/thinking`) read it defensively: a file that cannot be
parsed leaves the current values alone instead of failing the turn.

Environment variables override stored secrets: `COMMANDCODE_API_KEY`, `OPENROUTER_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`.
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
file reads. Every tool line opens with an emoji, never a typographic glyph (these are read in chat
clients), the tool **name is bold** so it does not read as the first word of its own arguments, and a
tool that fails adds `❌ <name> failed` to the same block. Names stay unemphasised inside the code
blocks, where Markdown is literal and the asterisks would simply show.

**Why each line gets its own block.** A quote block is a single paragraph, and a newline inside a
paragraph is a *soft break* — so two tool lines in one quote reflow into a single sentence, which is
how a search followed by a search read as "… preços web_search OpenAI new model release …". Every
quote line therefore opens its own block, and a thought (`💭 …`) is one of them: the thought is the
model talking, the arguments are data, and they are not the same thing. A code fence is not affected
— it keeps both the line breaks and the literals — so consecutive shell commands still share one
fence.

On Telegram the answer goes out as a **rich message** (Bot API 10.1+), so Markdown renders —
headings, lists, tables, code blocks — falling back to plain text if the API refuses it.
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
`/yolo`, `/tools full|name|off`, `/thinking on|off`, `/clear`, `/status`. A mode change from a chat is written to `config.json` like any other,
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
| `read_file` | yes | Line-numbered file contents; a long file comes back in pages. |
| `list_dir` | yes | One directory, not recursive. |
| `glob` | yes | Files matching a pattern, most recently modified first. |
| `grep` | yes | Regex over file contents, returning `path:line: text`. |
| `fetch_url` | yes | One http(s) URL, served back as text; a long page comes back in pages. |
| `write_file` | no | Creates or replaces a file; asks for confirmation. |
| `edit_file` | no | Exact string replacement; asks for confirmation. |
| `remember` | — | Saves a durable fact; only touches Milo's own memory, so it never asks. |
| `search_history` | yes | Term search over Milo's own past turns, reasoning and tool calls included. |
| `web_search` | yes | Registered only when a search provider is configured. |
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

### Display

How much of a turn you get to see is a per-install setting, not a per-surface one, so `/tools` typed
in Telegram applies to the terminal too — and the other way round. The bot gateways read it from
disk on every turn, so a change takes effect without restarting `milo serve`.

```json
{ "display": { "tools": "full", "thinking": true } }
```

| Setting | Values | What it does |
| --- | --- | --- |
| `tools` | `full` (default) | The tool call with its arguments: `⚡ shell_command npm test`. |
| | `name` | Just which tool ran: `⚡ shell_command` — the answer to "what is it doing?" without the argument dump. |
| | `off` | No tool lines at all. |
| `thinking` | `true` (default) | Show the model's reasoning. |
| | `false` | Hide it. |

A tool that **fails** is reported whichever level is set (`❌ shell_command failed`), and the CLI
stops naming the tool in its status line when `tools` is `off`: hiding that something went wrong is
worse than the noise it saves.

The two surfaces show reasoning differently, because they can: the CLI keeps a live pane with the
last few lines of the thought above the input, while a bot appends **one** line — `💭 the first line
of the thought` — since it edits a single message and the whole reasoning would crowd the answer out
of it.

A tool level is visible in the CLI header (`[tools name]`) because it takes away something that
would otherwise be there; a hidden thought gets no badge — the reasoning pane is simply not there —
and both settings are spelled out in `/status`. They are also the **Display** section of
`milo setup`, which is where a bot that answers several people has to change them.

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

```json
{ "maxTokens": 16384 }
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
a **binding** to the session currently attached to it, so the same session can be picked up from any
gateway. Bindings live in `sessions/bindings/<scope>.json`, one file per address: a single shared
map meant a read-modify-write of the whole thing on every turn, which drifts the moment `milo` and
`milo serve` run at the same time. (A `bindings.json` written by an older version is still read, and
each scope moves to its own file the next time it is bound.) Ids are claimed by creating the record
file exclusively, so two processes cannot hand out the same nickname.

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

That budget counts the **system prompt too** — the persona, the tool list, the recalled memories and
the running summary ride along with every request. Counting only the transcript let the real request
go over while the estimate said it was fine. `/stats` reports both numbers for the same reason.

## History

Sessions are the working state: they get cleared, compacted, deleted. The **history log** is the
record that outlives them — one append-only JSONL file per day under `~/.milo/history/`, written
`0600`, a line per event: every question, every answer, every tool call with its arguments and its
result, and the model's reasoning, each tagged with the session's name and the address it came from.
A turn writes its lines in one `append`, so the worst a kill can leave behind is a torn last line —
and the reader skips that instead of failing.

The reasoning is the part that had nowhere to go before: it was streamed to the screen and died with
the turn. It is now kept in the transcript — and deliberately never sent back. It is not part of the
conversation, so replaying it would pay for the same tokens twice; neither wire forwards it, and
`estimateTokens` does not count it, because a transcript is measured by what the provider receives,
not by what is on disk.

`search_history` is the read side: give it terms (all of them have to appear, any case) and it returns
the newest matches from the last 30 days, reading the reasoning, the tool arguments and the tool
results as well — which is what makes "what did we try for X?" answerable. The reply is capped and
says when there were more matches than it showed.

Plain text on disk is what keeps everything else working: `grep`, `jq`, `tail -f`, and Milo's own
`read_file` and `grep`. There is no index — the search walks day files, newest first, and stops at the
limit — which is the honest trade for a log this size, and the reason the format is JSONL rather than
SQLite: a database here would be a *derived* index, rebuildable from these files, for the day the
questions get heavier than "find that thing from last week".

## Memory

Memory sits behind a thin, vendor-agnostic interface (`remember` / `recall`). The MVP ships a
local `FileMemory` (JSON per conversation scope, keyword + recency retrieval). Third-party backends
(mem0, Honcho, Zep/Graphiti, Letta, MemPalace, Hindsight) plug in behind the same interface later —
nothing in the agent calls a vendor SDK directly.

Both halves of the interface are used. At the end of every turn Milo stores what the user said, and
the `remember` tool lets the model save a durable fact deliberately — a preference, a convention, a
decision — tagged `assistant` to tell it apart from a stored user message. Recall is keyword
overlap, so the tool is told to write short standalone sentences and not to save what is already in
the code or the transcript. It takes a batch, so one call can save several facts.

The recency term only ever **reorders** what the overlap found: it can add at most 0.5 to a score
that has to pass 0.5, so a memory that shares no word with the question does not come back. Recall
that answers every question with whatever was said most recently is worse than one that answers
nothing. Two-character words count (`rm`, `go`, `db`) — they used to be dropped from the index, which
meant a note could never be found by the exact term the user asks about.

Recall is not the only thing that reaches the model, and the rest is untrusted by construction: a
remembered line comes from something the user typed earlier, a compaction summary comes from the
transcript, and `web_search` snippets come from the open web. All three are fenced in the prompt
(`<memories>`, `<summary>`) with a line saying they are data and not instructions, and the reviewer
prompt says the same about the action it is judging.

## Skills / development

```bash
npm run dev         # run the CLI from source (tsx)
npm run serve       # run the bot gateways from source
npm run typecheck   # tsc --noEmit
npm run lint        # biome lint
npm test            # vitest
npm run build       # bundle to dist/ (tsup)
```

CI (`.github/workflows/ci.yml`) runs lint, types, tests with coverage and the build on every push
and pull request, on Node 20 and 22, plus a smoke run of the bundled binary. One trap
worth knowing: with `NODE_ENV=production` exported in your shell, npm treats every install as
`--omit=dev` and **prunes the toolchain** — `tsc`, `vitest` and `tsup` disappear. Recover with
`npm ci --include=dev`.

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
   `remember` / `recall` interface. Today: keyword overlap plus a recency bonus, over the user's
   messages and whatever the model chose to save with the `remember` tool. The history log is already
   searchable by term (`search_history`); ranked or vector recall over it is the open part.
3. **Memory across gateways.** Facts are keyed by the conversation address, so something told in
   Telegram is not visible in the CLI. Sharing them needs a per-person identity map.
4. **Web search needs a key.** `config.json` has no `search` section, so `web_search` is not even
   registered right now. The Exa and Parallel adapters exist but have never been called for real.
5. **More markdown in the Ink UI.** The terminal renders fences, inline code, bold and headings;
   tables, nested lists and links still arrive as plain text.
