# Tools

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
`mcp__<server>__<tool>` — see [MCP servers](mcp.md#mcp-servers).

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

## Classifier

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

## Display

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

## Reasoning effort

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

## Output limit

The Anthropic wire has a hard default of 4096 output tokens; OpenAI gets the provider's own default.

```yaml
maxTokens: 16384
```

Set `maxTokens` (or the **Output limit** row in `milo setup` → Display) to whatever the model really
supports; leave it out and each wire uses its own default. A turn that ends because of the limit says so
on both surfaces (`⚠ hit the output limit — the answer was cut off`).

## Web search

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

## Subagents

`task` hands a self-contained piece of work to a subagent: it runs the same loop with a **fresh
transcript** and returns only its final report. It is **on request only** — Milo does not delegate on
its own initiative. The subagent does not see the conversation and cannot ask anything, and it runs the
same tools as the parent **except `task` itself**, so a delegation is one level deep. `task` never asks
on its own, while every write or command the subagent attempts is put to the user the same way the
parent's would be; a `deny` entry for `task` blocks the delegation outright. Its own reads and searches
are not streamed — only the report comes back.
