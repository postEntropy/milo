# Memory

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
