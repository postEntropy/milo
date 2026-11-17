# History

Sessions are the working state; the **history log** outlives them — one append-only JSONL file per day
under `~/.milo/history/`, written `0600`, a line per event: every question, every answer, every tool
call with its arguments and result, and the model's reasoning, each tagged with the session's name and
the address it came from. A turn writes its lines in one `append`.

The reasoning is kept in the transcript but not replayed to the model, so neither wire sends it back —
except the Anthropic wire, which signs its thinking blocks and requires them echoed once thinking is
on.

`search_history` is the read side: terms (all of them have to appear, any case), the newest matches from
the last 30 days, reading the reasoning, the tool arguments and the tool results. Pass `session` to stay
inside one session. Recall reads the log through an index bounded by `history.windowDays` (default
365; `0` keeps every day). The log itself is never trimmed on its own: `milo history` reports what it
holds, and `milo history trim --older-than <days>` (or `--before <date>`) deletes the days you name.

## Taking a session out

`/export` writes the current session to `~/.milo/exports/` — Markdown by default, `/export json` for
the entries themselves — and replies with the path, the counts and the size. It is the whole log: every
message, every tool call with its arguments and its **full** result, and the reasoning, in order. It
reads the **history log**, not the session's transcript, which is compacted and drops old screenshots. A
session with no turns exports nothing and says so.

`recall` answers the other half — not *what* was said but *which session* — ranking saved sessions
by how well their recap, title and first words match the query. `search_history` walks the day files;
recall runs before every turn and uses an index, `~/.milo/history/turns.db`, derived from those files
and rebuildable from them.

## Execution log

The history log holds *what was said*; the **execution log** at `~/.milo/traces.jsonl` holds *what it
cost* — one append-only JSONL file, a line per event, each with `at`, `event`, `ok` and `ms` plus its own
numbers. New events include model inputs and outputs, referenced attachment bytes, tool arguments and results, and classifier inputs and answers.
The log can therefore contain the full contents of Sessions, internal instructions and tool results. It is
stored locally with owner-only file permissions and is available to authenticated web and iOS clients.

Six events, each a closed name:

- `model.request` — one call to the chat model: `purpose` (`chat`, `task`, `compaction`, `recap`,
  `derive`), `model`, `provider`, `ttftMs` (time to the first token), `ms`, `inputTokens`, `outputTokens`,
  `finish`, and `surface`/`session` for a chat turn, plus the input, streamed output and turn identifier when available.
- `classifier.request` — the decision model: `purpose` (`danger`, `mail-labels`), `backend`, `model`,
  `cached`, and the typed answer it gave.
- `embedding.request` — an embedding model call, including its input texts and returned vectors.
- `tool.call` — `tool`, `ms`, `ok`, call id, arguments and result.
- `turn` — the whole turn: `surface`, `session`, `model`, `ms`, `ok`.
- `verification` — the checks run after a turn changes a folder.

The Analytics pages on web and iOS read the same log, filter it and open a turn timeline. Older events
remain readable with their original, more limited details.
Model inputs are the provider-neutral requests passed into Milo's provider interface, and outputs are
the normalized stream events it returns; they are not a byte-for-byte HTTP capture. Embedding outputs
are the normalized vectors used by memory. Authentication headers are not part of these records.

Command Code runs in its own process. Milo logs the turn, its input and the native transcript returned
for it; the process's internal model requests and their usage are not exposed as Milo model requests.

Every model call goes through one seam (`Provider.stream`), so wrapping it once covers the chat turn, a
delegated subtask and the mechanical calls alike, from one measurement instead of counting the same span
at each caller. The classifier and embedding engine are clients of their own and are timed where they run.

The log is on by default (`traces.enabled`); `false` turns it off and nothing else changes. It is never
trimmed on its own — `milo log` reports what it holds (`status`), shows the last few events (`tail [n]`),
follows new ones live (`milo log -f [n]`, Ctrl+C to stop), and `milo log trim --older-than <days>` (or
`--before <date>`) drops the old ones.
