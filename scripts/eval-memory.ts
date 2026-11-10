import process from 'node:process'
import { loadConfig, readAuth } from '../src/core/config/load.js'
import { OLLAMA_URL } from '../src/core/config/schema.js'
import type { Embedder } from '../src/core/memory/embed.js'
import { embedderFor, embeddingKey } from '../src/core/memory/index.js'
import { engineAnswers } from '../src/core/memory/ollama.js'
import { INSTALL_SCOPE } from '../src/core/memory/types.js'
import {
  EVAL_LIMIT,
  NOTES,
  REWORDED,
  runEval,
  seedEvalStore,
  type Metrics,
} from '../test/fixtures/memory-eval.js'
import { stressRecall } from '../test/fixtures/memory-stress.js'

/**
 * What recall costs in answers, not only in milliseconds.
 *
 * `bench:memory` measures how long a recall takes; this measures whether the
 * reply was any good — precision@5, recall@5, MRR, and the share of questions
 * nothing answers that came back with notes anyway. Two rows per configuration,
 * with the coverage rule off against it on, so a change has to show up as a
 * number rather than an argument.
 *
 * The keyword rows need nothing. `--semantic` adds the rows that use the embedder
 * the install is configured with — the same one `bootstrap.ts` wires in, local or
 * hosted — and skips them with a line when there is none, or when a local engine
 * is not up. This is a measurement and not a consumer, so it starts nothing.
 *
 *   npm run eval:memory
 *   npm run eval:memory -- --semantic
 *   npm run eval:memory -- --no-coverage
 *   npm run eval:memory -- --stress --json
 *
 * A free embedding model takes twenty requests a minute and the set is about
 * eighty, so that run needs `MILO_EVAL_PACE_MS=3200` to complete at all. The
 * pause is taken between questions, outside the measured call.
 */
const args = new Set(process.argv.slice(2))
const validArgs = new Set(['--semantic', '--no-coverage', '--json', '--stress', '--coverage-only'])
for (const arg of args) {
  if (!validArgs.has(arg)) throw new Error(`Unknown argument ${arg}. Valid arguments: ${[...validArgs].join(', ')}`)
}
if (args.has('--coverage-only') && args.has('--no-coverage')) {
  throw new Error('Choose either --coverage-only or --no-coverage')
}
const wantSemantic = args.has('--semantic')
const wantCoverage = !args.has('--no-coverage')
const asJson = args.has('--json')

interface Row extends Metrics {
  config: string
}

const rows: Row[] = []
const stressRows: { config: string; passed: number; total: number; results: Awaited<ReturnType<typeof stressRecall>> }[] = []
const report = (message: string) => asJson ? console.error(message) : console.log(message)

/**
 * How long to wait after each question, for a model that is rate-limited.
 *
 * Learning this the hard way is why the number is here at all: a free tier takes
 * twenty requests a minute, the set is about eighty requests, and the first run
 * was refused halfway through. Milo falls back to words quietly on purpose — a
 * turn must not fail because the engine is busy — so the table said
 * `semantic 32.9%` for a run where the model had answered almost nothing.
 * `MILO_EVAL_PACE_MS=3200` spends about five minutes on the set and is honest.
 */
const PACE_MS = Number(process.env.MILO_EVAL_PACE_MS ?? 0)
if (!Number.isFinite(PACE_MS) || PACE_MS < 0) throw new Error('MILO_EVAL_PACE_MS must be a nonnegative number')

/**
 * Wraps an embedder to count what it refuses.
 *
 * The count is the point. A model that is rate-limited does not fail loudly
 * anywhere recall can see, so the only honest way to print a row is to know how
 * many calls never landed — and to withhold the row when any of them did not.
 */
function watch(embedder: Embedder) {
  const state = { calls: 0, failures: 0 }
  return {
    state,
    embedder: {
      model: embedder.model,
      async embed(texts: string[]): Promise<Float32Array[]> {
        state.calls += 1
        try {
          return await embedder.embed(texts)
        } catch (error) {
          state.failures += 1
          throw error
        }
      },
    } satisfies Embedder,
  }
}

/** One configuration, measured on its own store so nothing leaks between them. */
async function measure(config: string, options: { embedder?: Embedder; coverage: boolean }) {
  const watched = options.embedder ? watch(options.embedder) : null
  if (args.has('--stress')) {
    const results = await stressRecall({ embedder: watched?.embedder, coverage: options.coverage, pauseMs: PACE_MS })
    if (watched && watched.state.failures > 0) throw new Error(`${config}: embedding calls failed; stress results withheld`)
    const row = { config, passed: results.filter((result) => result.passed).length, total: results.length, results }
    stressRows.push(row)
    if (!asJson) {
      console.log(`  ${config}: ${row.passed}/${row.total} cases returned exactly the expected evidence`)
      for (const result of results) {
        console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.name}`)
        if (!result.passed) console.log(JSON.stringify({ query: result.query, expected: result.expected, returned: result.returned }))
      }
    }
    return
  }
  const seeded = await seedEvalStore({
    embedder: watched?.embedder,
    memory: { coverage: options.coverage },
  })
  let metrics: Metrics
  try {
    if (seeded.facts !== NOTES.length) {
      // A `sameFact` collapse would quietly shrink the set, and every number below
      // would be measured against notes that are not there.
      throw new Error(`seeded ${NOTES.length} notes but the store kept ${seeded.facts}`)
    }

    metrics = await runEval(
      (query, limit) => seeded.memory.recall(INSTALL_SCOPE, query, { limit }),
      EVAL_LIMIT,
      { pauseMs: PACE_MS },
    )
  } finally {
    seeded.close()
  }

  if (watched && watched.state.failures > 0) {
    // Not a row. With the model refusing, recall answers from words — which is
    // the right thing for a turn and the wrong thing to print as `semantic`.
    report(
      `  ${config.padEnd(22)} NOT measured — ${watched.state.failures} of ${watched.state.calls} embedding calls failed`,
    )
    return
  }

  rows.push({ config, ...metrics })
  if (!asJson) print({ config, ...metrics })
}

function print(row: Row): void {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`.padStart(7)
  console.log(
    `  ${row.config.padEnd(22)} precision ${percent(row.precision)}   recall ${percent(
      row.recall,
    )}   mrr ${row.mrr.toFixed(3)}   no-answer ${percent(row.falsePositiveRate)}   reworded ${String(
      row.reworded,
    ).padStart(2)}/${REWORDED.length}   p50 ${row.latencyMs.toFixed(2).padStart(6)} ms`,
  )
}

report(args.has('--stress') ? '\nrecall stress eval — isolated evidence cases\n' : `\nrecall eval — ${NOTES.length} notes, ${EVAL_LIMIT} per reply\n`)

report('keyword')
if (!args.has('--coverage-only')) await measure('keyword', { coverage: false })
if (wantCoverage) await measure('keyword + coverage', { coverage: true })

if (wantSemantic) {
  const loaded = loadConfig()
  const embedding = loaded?.config.memory.embedding
  if (!loaded || !embedding) {
    report('\nsemantic — skipped: no embedder in the config (milo setup → Memory)')
  } else {
    const local = embedding.provider === 'ollama'
    const url = embedding.url ?? OLLAMA_URL
    // A local engine that is not up would embed nothing, and the semantic rows
    // would quietly be the keyword rows again — a misleading table is worse than
    // a missing one. A hosted one is nobody's process to check.
    if (local && !(await engineAnswers(url))) {
      report(`\nsemantic — skipped: nothing answers at ${url} (start one with \`milo setup\`)`)
    } else {
      const embedder = embedderFor(embedding, embeddingKey(loaded.config, readAuth()))
      if (!embedder) {
        report('\nsemantic — skipped: the configured embedder has no key')
      } else {
        report(`\nsemantic — ${embedder.model} (${embedding.provider})`)
        if (!args.has('--coverage-only')) await measure('semantic', { embedder, coverage: false })
        if (wantCoverage) await measure('semantic + coverage', { embedder, coverage: true })
      }
    }
  }
}

if (asJson) console.log(JSON.stringify(args.has('--stress') ? stressRows : rows, null, 2))
else if (!args.has('--stress')) console.log('\n`no-answer` is the share of questions nothing answers that returned notes anyway.\n')
