# Sessions

A **session** has its own name (`calm-otter-7`) and is stored as one JSON file under
`~/.milo/sessions/`. The file is written on the session's **first turn**: a run that opens a
session and never speaks in it leaves nothing behind, so opening the CLI or the web UI does not
litter the directory. A transport address is only a **binding** to the session attached to it, so the
same session can be picked up from any gateway. Bindings live in `sessions/bindings/<scope>.json`, one
file per address. Two turns never run on one session at once: a turn takes a **lease** for as long as it
runs, so two terminals that both bind `cli:main` take turns. The record carries a **revision**, so a
save built from a stale copy is refused instead of overwriting a newer one.

| Command | What it does |
| --- | --- |
| `/new [title]` | Starts a fresh session and binds this chat to it. |
| `/sessions` | Lists the saved sessions, most recent first. |
| `/resume <id>` | Binds this chat to an existing session. |
| `/fork [id] [turn]` | Branches into a new session from this or a named one. |
| `/stats` | Name, timestamps, message/turn counts and context size for the current session. |
| `/clear` | Forgets the current session's transcript (destructive). |

In the terminal, `milo` begins a new session every time it opens, and the one you were in stays on
disk. `milo --continue` picks that one back up, and `milo --resume <id>` opens a specific one.
`sessions.maxSessions` (default 50) caps the directory: at startup the oldest sessions beyond it are
pruned, never one a scope is still bound to. Sessions nothing was ever said in are swept too, whatever
the cap and whatever is bound to them — an empty record holds nothing, and a leftover older Milo left
behind goes on the next launch. `0` lifts the cap. Pruning only trims the working transcript; the log
`recall` and `search_history` read is untouched.

Memory is keyed to the install, not to a session: a `/new` never changes what Milo remembers. Leaving
a session writes a short **recap** in the model's own words, kept out of the session file in
`sessions/recaps/<id>.json` and shown by `/sessions`. On Telegram and Discord, `/new`,
`/sessions` and `/resume` only work on a single-person bot (exactly one id in the allowlist).

With `sessions.generateTitles` (default `true`) a session is also **named** from the turn it opened
with: one short call, made in the background right after the first reply, so nothing waits on it. A
session already named — `/new <title>`, a rename, a fork that inherited one — is never renamed over,
and a routine's own run is never named at all. `sessions.titleModel` picks the model that writes the
name; left out, the session's own chat model does. Where there is no name, every surface falls back to
the first message: a terminal, Telegram and Discord draw `calm-otter-7 — <the words it opened with>`,
the browser and the phone draw the words alone.

The agent has its own view of the same list. It knows which session it is in — the id rides the
system prompt, so "which session am I in?" is answered without reading the directory — and it carries a
`sessions` tool: **list** the saved ones with what each was about, or **remove** one by its id. A
removal asks before it happens, will not take the session it is running in, and is withheld where the
`/sessions` command is locked (a shared bot) and from a routine's own run. It reads and drops through
the same `listSessions`/`removeSession` the surfaces use, so the agent's view of the list cannot drift
from the person's.

## Task lists

The other thing that outlives a session. The `task_lists` tool keeps named checklists for the person —
`list`, `create`, `show`, `add`, `complete`, `remove`, `rename`, `delete` — in
`~/.milo/task-lists.json`, shared by every session and surface, so a list started in the terminal is
the one the web's **Task lists** view shows. It is Milo's own state, so it never asks; it is not the
`todo` checklist, which is the plan for the task at hand and lives only as long as that task.

## Compaction

Once a request passes `sessions.compactAt` **of the model's context window** (estimated at ~4 characters
per token), the oldest turns are summarized in one model call and replaced by an `## Earlier in this
conversation` section of the system prompt; the last `sessions.keepTurns` turns are kept verbatim. The
cut always lands on a user turn, so a tool call is never separated from its result. If the summary call
fails, the turns are dropped anyway — and every surface says which happened: the fold is named while it
runs and reports what it came to, the turns folded and the tokens they were worth, whether it was the
automatic pass or `/compact` asked for by hand. `/stats` carries the total the session has summarized away.
Near the limit, Milo prepares the next summary after answering, during the gap before the next turn. It
uses that summary only if the transcript, model and prompt budget still match; otherwise it summarizes
the current transcript before sending the next request.

```yaml
sessions:
  compactAt: 0.7
  keepTurns: 8
  compaction: true
  generateTitles: true
  titleModel: some/cheap-model
```

The window comes from the model's profile — the provider's own catalog plus OpenRouter's
`context_length` — cached in `~/.milo/models.json` for a week; `sessions.contextWindow` overrides it,
and `maxInputTokens` is the fallback when nothing knows the window. The budget counts the **system
prompt too**, and `/stats` shows the count against the ceiling. When even the most recent turn plus
the prompt is over the ceiling, the summary is **not called at all**.
