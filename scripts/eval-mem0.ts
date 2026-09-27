import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { loadConfig, readAuth } from '../src/core/config/load.js'
import { embedderFor, embeddingKey } from '../src/core/memory/index.js'
import { words } from '../src/core/memory/tokenize.js'
import {
  EVAL_LIMIT,
  NOTES,
  QUESTIONS,
  REWORDED,
  UNANSWERABLE,
  score,
  scoreReply,
} from '../test/fixtures/memory-eval.js'

/**
 * Runs the recall eval set against mem0, on the same notes and the same
 * questions, and scores it with the same function Milo is scored with.
 *
 * The point is not to prove anything about mem0 — it is a well-regarded memory
 * layer built much the way this one is (BM25 and vectors, fused). The point is
 * that "ours is good" is a claim about a number, and a number about one
 * implementation is not a comparison. This is the other side of the ruler.
 *
 * Two modes, and they are two different questions:
 *
 * - default: `infer=False`, so mem0 stores each note **verbatim**, which is what
 *   Milo's `remember` does. This is the architecture comparison, and the only one
 *   an exact-text scorer can grade fairly.
 * - `--infer`: mem0's own pipeline, where a language model reads the notes and
 *   decides what is worth keeping. It costs a model call per phase, and it writes
 *   the memories in **its own words** — so exact text stops being the right
 *   instrument, because a note that survived as "the user's editor is Neovim"
 *   scores as a miss. That run prints both readings.
 *
 * mem0 is Python, so the answering happens in `mem0-bridge.py` and comes back as
 * JSON. It needs its own virtualenv; the driver only needs to be told where:
 *
 *   uv venv --python 3.11 "$MILO_MEM0_DIR/.venv"
 *   uv pip install --python "$MILO_MEM0_DIR/.venv/bin/python" mem0ai
 *   MILO_MEM0_PYTHON="$MILO_MEM0_DIR/.venv/bin/python" npm run eval:mem0
 *   MILO_MEM0_PYTHON="…" npm run eval:mem0 -- --infer
 */
const python = process.env.MILO_MEM0_PYTHON ?? 'python3'
const base = process.env.MEM0_BASE_URL ?? 'https://openrouter.ai/api/v1'
const infer = process.argv.includes('--infer')
const label = infer ? 'mem0 pipeline' : 'mem0 verbatim'

const loaded = loadConfig()
const embedding = loaded?.config.memory.embedding
if (!loaded || !embedding) {
  console.log('\neval:mem0 — nothing to compare against: no embedder in the config (milo setup → Memory)')
  process.exit(0)
}
if (embedding.provider !== 'openrouter') {
  // mem0 reaches models over the OpenAI wire. Milo's local engine speaks Ollama,
  // which mem0 does not embed through, so this would be two different things.
  console.log(`\neval:mem0 — needs the OpenRouter embedder; the config says ${embedding.provider}`)
  process.exit(0)
}

// Resolved by the product's own functions, so both sides read text into vectors
// with one model and the comparison is about architecture rather than about who
// has the better embedder.
const key = embeddingKey(loaded.config, readAuth())
const resolved = embedderFor(embedding, key)
if (!resolved || !key) {
  console.log('\neval:mem0 — the configured embedder has no key')
  process.exit(0)
}

const dir = mkdtempSync(path.join(tmpdir(), 'milo-mem0-'))
const dataset = path.join(dir, 'dataset.json')
writeFileSync(
  dataset,
  JSON.stringify({
    notes: NOTES,
    questions: QUESTIONS.map((question) => question.query),
    unanswerable: UNANSWERABLE,
    reworded: REWORDED.map((question) => question.query),
  }),
)

console.log(`\n${label} — ${resolved.model} (${embedding.provider}), ${NOTES.length} notes\n`)

const run = spawnSync(
  python,
  [path.join(import.meta.dirname, 'mem0-bridge.py'), '--dataset', dataset],
  {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
    env: {
      ...process.env,
      MEM0_BASE_URL: base,
      MEM0_API_KEY: key,
      MEM0_EMBED_MODEL: resolved.model,
      MEM0_LLM_MODEL: process.env.MEM0_LLM_MODEL ?? 'openai/gpt-4o-mini',
      MEM0_INFER: infer ? '1' : '0',
      MEM0_TOP_K: String(EVAL_LIMIT),
      MEM0_STORE_DIR: path.join(dir, 'qdrant'),
    },
  },
)

if (run.status !== 0) {
  console.log(`  not measured — the bridge exited ${run.status}`)
  // What the bridge says is the whole output, and it redacts the key first.
  if (run.stderr?.trim()) console.log(`  ${run.stderr.trim().split('\n').slice(-3).join('\n  ')}`)
  process.exit(1)
}

const collected = JSON.parse(run.stdout) as {
  stored: number
  distinct: number
  replies: string[][]
  unanswerable: number[]
  reworded: string[][]
  latencies: number[]
}

if (collected.stored !== collected.distinct) {
  // The store is holding the same text more than once, so a reply can say the
  // same thing twice and recall climbs past 100%. That is a broken measurement
  // and not a bad score, so it stops rather than printing a number.
  console.log(
    `  not measured — ${collected.stored} rows for ${collected.distinct} distinct memories`,
  )
  process.exit(1)
}
if (collected.distinct !== NOTES.length) {
  // Expected with `--infer`, and the thing worth seeing: the pipeline deciding
  // how many memories the notes deserved, and in its own words.
  console.log(
    `  ${NOTES.length} notes in, ${collected.distinct} memories out — the pipeline rewrote them`,
  )
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`.padStart(7)

// A reply that says the same note twice is not two notes, so the distinct texts
// are what get scored. Milo never returns a sentence twice, so nothing changes on
// its side.
const replies = collected.replies.map((reply) => [...new Set(reply)])
// Scored by the same function Milo's is, from the raw replies: the bridge is not
// allowed an opinion about whether an answer came back.
const reworded = collected.reworded.map(
  (reply, index) => scoreReply(reply, REWORDED[index]!.answers).recall > 0,
)
const metrics = score({ ...collected, replies, reworded })
const perReply = replies.reduce((sum, reply) => sum + reply.length, 0) / replies.length

console.log(
  `  ${label.padEnd(22)} precision ${percent(metrics.precision)}   recall ${percent(
    metrics.recall,
  )}   mrr ${metrics.mrr.toFixed(3)}   no-answer ${percent(
    metrics.falsePositiveRate,
  )}   reworded ${String(metrics.reworded).padStart(2)}/${REWORDED.length}   p50 ${metrics.latencyMs
    .toFixed(2)
    .padStart(6)} ms`,
)

if (infer) {
  // The only fair way to grade a system that writes its own sentences: did the
  // *content* of the answer survive into the reply, whichever words carried it.
  const kept =
    QUESTIONS.reduce((sum, question, index) => {
      const said = new Set((replies[index] ?? []).flatMap((text) => words(text)))
      const wanted = words(question.answers.join(' '))
      const found = wanted.filter((word) => said.has(word)).length
      return sum + (wanted.length === 0 ? 0 : found / wanted.length)
    }, 0) / QUESTIONS.length
  console.log(
    `  ${' '.repeat(22)} content kept ${percent(kept)} — how much of the answer's own words came back`,
  )
}

// The width of the reply matters as much as the scores: precision is a share of
// what came back, so a store that returns fewer notes is graded on fewer notes.
console.log(
  `  (${collected.stored} stored, ${collected.distinct} distinct, ${perReply.toFixed(1)} per reply)\n`,
)
