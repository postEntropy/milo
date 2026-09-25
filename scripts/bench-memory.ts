import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import { TurnIndex } from '../src/core/memory/turns.js'
import type { Memory, MemoryInput, MemoryScope } from '../src/core/memory/types.js'

/**
 * `recall` runs before every turn, so its latency is added to the time it takes
 * the model to start answering. This measures both halves of it where Milo
 * actually holds the notes: the facts in SQLite, and the turns in the history
 * index beside the log.
 *
 * `RUNS=500 npm run bench:memory`
 */
const SCOPE: MemoryScope = { gateway: 'cli', conversationId: 'bench' }
const RUNS = Number(process.env.RUNS ?? 200)

const QUERIES = [
  'qual a tag de release do milo?',
  'como funciona o deploy do servidor?',
  'o que eu uso como editor?',
  'qual a capital da franca?',
]

const seed = (count: number): MemoryInput[] =>
  Array.from({ length: count }, (_, i) =>
    i % 50 === 0
      ? { text: `a tag de release do milo e v0.${i}` }
      : { text: `nota ${i} sobre o modulo de deploy do servidor numero ${i % 37}` },
  )

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

async function recallLatency(memory: Memory, runs: number): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const query = QUERIES[i % QUERIES.length]!
    const started = performance.now()
    await memory.recall(SCOPE, query, { limit: 5 })
    samples.push(performance.now() - started)
  }
  return samples
}

async function writeLatency(memory: Memory, runs: number): Promise<number[]> {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    await memory.remember(SCOPE, [{ text: `fato novo numero ${i}` }])
    samples.push(performance.now() - started)
  }
  return samples
}

async function measure(label: string, memory: Memory, size: number) {
  // Seeded in batches: one call per item measures the seed, not the store.
  const items = seed(size)
  for (let i = 0; i < items.length; i += 50) {
    await memory.remember(SCOPE, items.slice(i, i + 50))
  }

  const recall = await recallLatency(memory, RUNS)
  const write = await writeLatency(memory, Math.max(20, Math.floor(RUNS / 10)))

  const rows = [
    ['recall', recall],
    ['remember', write],
  ] as const

  for (const [name, samples] of rows) {
    const p50 = percentile(samples, 50)
    const p95 = percentile(samples, 95)
    console.log(
      `  ${name.padEnd(9)} p50 ${p50.toFixed(2).padStart(7)} ms   p95 ${p95.toFixed(2).padStart(7)} ms   (${samples.length} runs)`,
    )
  }
  console.log(`  ${label}: ${size} items in scope`)
}

const dir = mkdtempSync(path.join(tmpdir(), 'milo-bench-'))

console.log(`\nnode ${process.version}\n`)

console.log('SqliteMemory')
await measure('sqlite', new SqliteMemory({ dir: path.join(dir, 'small') }), 500)
await measure('sqlite', new SqliteMemory({ dir: path.join(dir, 'large') }), 5000)

/** One day-file with `count` turns in it, the shape the log actually grows in. */
function seedLog(logDir: string, count: number): void {
  mkdirSync(logDir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const lines = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      at: new Date(Date.now() - i * 1_000).toISOString(),
      session: 'calm-otter-7',
      scope: 'cli:main',
      kind: 'user',
      text:
        i % 50 === 0
          ? `a tag de release do milo e v0.${i}`
          : `nota ${i} sobre o modulo de deploy do servidor numero ${i % 37}`,
    }),
  )
  writeFileSync(path.join(logDir, `${day}.jsonl`), `${lines.join('\n')}\n`)
}

async function measureTurns(label: string, logDir: string, size: number): Promise<void> {
  seedLog(logDir, size)

  // The first pass reads the whole log, which is a one-off: it is what an install
  // pays once when the index is built, and never again.
  const started = performance.now()
  const turns = new TurnIndex({ dir: logDir })
  const built = performance.now() - started

  const samples: number[] = []
  for (let i = 0; i < RUNS; i++) {
    const query = QUERIES[i % QUERIES.length]!
    const at = performance.now()
    await turns.recall(SCOPE, query, { limit: 5 })
    samples.push(performance.now() - at)
  }
  const p50 = percentile(samples, 50)
  const p95 = percentile(samples, 95)
  console.log(
    `  recall    p50 ${p50.toFixed(2).padStart(7)} ms   p95 ${p95.toFixed(2).padStart(7)} ms   (${samples.length} runs)`,
  )
  console.log(`  ${label}: ${size} turns in the log · first index ${built.toFixed(0)} ms`)
  turns.close()
}

console.log('\nTurnIndex')
await measureTurns('turns', path.join(dir, 'log-small'), 500)
await measureTurns('turns', path.join(dir, 'log-large'), 5000)

console.log(
  '\nThe queries are the hot path above; `remember` runs at the end of a turn, off it.\n',
)
