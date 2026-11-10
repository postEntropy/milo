# Memory

Memory sits behind a thin, vendor-agnostic interface (`remember` / `recall`). Milo's own store is **one
SQLite file** at `~/.milo/memory/memory.db`, written `0600`, searched with FTS5/BM25 — no account, no
key, no service, no network, and with the embedder off nothing you said leaves the machine. It is the
only backend: `scripts/eval-mem0.ts` runs the same eval set through mem0 as a yardstick, not as a store
Milo uses.

The store holds:

- **`fact`** — something worth keeping past the session: what `remember` saves, and what the end of
  a turn is read for. Nothing ever evicts one.
- **the turns themselves** — what the person typed, already in the history log and indexed from there by
  `turns.db`. One copy, in the artifact that outlives every session, `/clear` and compaction.

Recall reads the question as an FTS5 `MATCH` (words OR-ed, diacritics folded), reads facts first and
fills the rest of the reply with turns, so a durable note is not drowned by chatter. The same note saved
twice is one row; a turn collapses to the newest telling, with the verbatim history left in the log.
The `remember` tool is the deliberate half, and the end of a turn is read for facts as well. A derived
fact has to stand on the person's own words — it carries a verbatim quote from their message, and a
line that cannot quote them is dropped, so the answer is context for reading it, never the source.
Automatic extraction then asks the model to review its candidates independently against the full
list of saved notes and keeps at most two that the review explicitly accepts. The review treats a
correction as a distinct fact and skips a candidate only when an existing note already covers it; an unavailable or malformed review keeps none. This is a second
model call only when there are candidates, with its own latency and cost. It sends the saved notes
to the same provider used for extraction, which can increase the request size. It reduces noise but cannot
guarantee a judgment is correct. The separate `remember` tool compares requested facts with the
same full list for duplicates but does not apply the automatic extraction's quality filter. A failed or
unreadable comparison reports an error rather than claiming to have saved the note. The tool is reserved
by its instructions for explicit requests to remember; that instruction is not a technical guarantee
that a model will obey it. The comparison is a snapshot: concurrent turns can still race, while the
store itself checks all notes for lexical duplicates at the time of writing.

## Recall by meaning, off by default

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

## The old store

`memory.db` is the only backend. The first open **imports** whatever is in `~/.milo/memory/*.json` —
once, keeping each item's original timestamp, and skipping items the old store tagged `user`, which were
turns that live in the log — and then **leaves the JSON files where they are**. It also drops the copied
turns the store used to keep, and the `kind` column with them.

Recall is not the only thing that reaches the model, and the rest is untrusted by construction: a
remembered line, a compaction summary and `web_search` snippets all arrive fenced (`<memories>`,
`<summary>`) with a line saying they are data, not instructions.

`milo setup` → **Memory** shows what is actually in the store — facts, turns, size and where it lives,
with the recall-by-meaning line.

## Inspecting and correcting notes

Settings → Memory on the web and phone lists notes in pages and searches the facts by their words.
Each note can be edited or forgotten. A correction preserves its id, refreshes the search index,
and clears its old source because the corrected text no longer necessarily says the same thing.
New automatically derived facts keep the supporting words and session id; older facts and facts
without a recorded source say the source is unavailable. The date is when the fact was last said or corrected,
not necessarily when it was first saved.

On every chat surface `/memory` lists notes, `/memory search <words>` searches,
`/memory page <number>` pages the list (`/memory search <words> --page <number>` pages search results), `/memory edit <id> <text>` corrects one and
`/memory forget <id>` removes one. The `memories` tool can search, list, edit and forget the same
notes; editing and forgetting through the agent ask for permission. Editing or forgetting a note does
not remove the original words from the history log or a Session, and those words can still be recalled.
