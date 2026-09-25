import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { FileMemory } from '../src/core/memory/local.js'
import { SqliteMemory } from '../src/core/memory/sqlite.js'
import type { Memory, MemoryInput, MemoryScope } from '../src/core/memory/types.js'

/**
 * `recall` runs before every turn, so its latency is added to the time it takes
 * the model to start answering. This measures it where Milo actually holds the
 * notes, and compares the two stores at the size each can hold: `FileMemory`
 * caps a scope at 500 items, which is also why it cannot be measured at 5,000.
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
      ? { text: `a tag de release do milo e v0.${i}`, kind: 'fact' as const }
      : { text: `nota ${i} sobre o modulo de deploy do servidor numero ${i % 37}`, kind: 'said' as const },
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
    await memory.remember(SCOPE, [{ text: `turno novo numero ${i}`, kind: 'said' }])
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

console.log('\nFileMemory (its 500-item cap)')
await measure('file', new FileMemory({ dir: path.join(dir, 'file') }), 500)

console.log(
  '\nThe queries are the hot path above; `remember` runs at the end of a turn, off it.\n',
)
