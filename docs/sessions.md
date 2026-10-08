# Sessions

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
