import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Embedder } from '../../src/core/memory/embed.js'
import { installMemory } from '../../src/core/memory/index.js'
import { SqliteMemory } from '../../src/core/memory/sqlite.js'
import { TurnIndex } from '../../src/core/memory/turns.js'
import { INSTALL_SCOPE } from '../../src/core/memory/types.js'
import { scoreReply } from './memory-eval.js'

/** Retrieval evidence, not answer accuracy: a language model must still interpret it. */
interface Scenario {
  name: string
  notes: string[]
  turns?: { text: string; session: string; scope: string }[]
  query: string
  answers: string[]
}

const CASES: Scenario[] = [
  {
    name: 'accented evidence competes with an unaccented distractor',
    notes: ['Minha restrição alimentar é não comer camarão.', 'A restricao de acesso exige senha.'],
    query: 'qual minha restricao alimentar sobre camarao?',
    answers: ['Minha restrição alimentar é não comer camarão.'],
  },
  {
    name: 'decomposed accents reach the same evidence',
    notes: ['Minha restrição alimentar é não comer camarão.', 'A restricao de acesso exige senha.'],
    query: 'qual minha restrição alimentar sobre camarão?'.normalize('NFD'),
    answers: ['Minha restrição alimentar é não comer camarão.'],
  },
  {
    name: 'a correction keeps both pieces of evidence available',
    notes: ['My editor was Neovim in January.', 'My editor is now Emacs since March.'],
    query: 'How did my editor change from January to March?',
    answers: ['My editor was Neovim in January.', 'My editor is now Emacs since March.'],
  },
  {
    name: 'a negation survives beside its earlier value',
    notes: ['I drink coffee with sugar.', 'I no longer drink coffee with sugar.'],
    query: 'What did I say about coffee and sugar?',
    answers: ['I drink coffee with sugar.', 'I no longer drink coffee with sugar.'],
  },
  {
    name: 'two constraints can be recalled together',
    notes: ['My keyboard must support Colemak.', 'My keyboard must have split halves.', 'My monitor supports HDR.'],
    query: 'What are my keyboard constraints?',
    answers: ['My keyboard must support Colemak.', 'My keyboard must have split halves.'],
  },
  {
    name: 'an unknown personal fact shares a topic with known facts',
    notes: ['My sister Ana lives in Recife.', 'My sister Ana plays tennis.'],
    query: 'When is my sister Ana birthday?',
    answers: [],
  },
  {
    name: 'an unknown project value shares its entity with known values',
    notes: ['The Atlas deployment runs on Friday.', 'The Atlas deployment uses Docker.'],
    query: 'What is the Atlas deployment password?',
    answers: [],
  },
  {
    name: 'a paraphrase uses a different vocabulary',
    notes: ['I play guitar every weekend.', 'My editor is Neovim.'],
    query: 'What is my hobby?',
    answers: ['I play guitar every weekend.'],
  },
  {
    name: 'a question switches languages',
    notes: ['Meu teclado é um Corne com layout Colemak.', 'Meu editor é o Neovim.'],
    query: 'Which keyboard layout do I use?',
    answers: ['Meu teclado é um Corne com layout Colemak.'],
  },
  {
    name: 'history supplies a decision that was never saved as a fact',
    notes: [],
    turns: [{ text: 'We chose SQLite for the archive.', session: 'archive-one', scope: 'cli:main' }],
    query: 'What did we choose for the archive?',
    answers: ['We chose SQLite for the archive.'],
  },
  {
    name: 'history joins evidence from different sessions and gateways',
    notes: [],
    turns: [
      { text: 'The archive requires offline access.', session: 'archive-one', scope: 'cli:main' },
      { text: 'The archive requires encrypted backups.', session: 'archive-two', scope: 'telegram:42' },
    ],
    query: 'What does the archive require?',
    answers: ['The archive requires offline access.', 'The archive requires encrypted backups.'],
  },
  {
    name: 'an unrelated question has no evidence',
    notes: ['My editor is Neovim.', 'I play guitar every weekend.'],
    query: 'What is the capital of Iceland?',
    answers: [],
  },
]

export async function stressRecall(options: { embedder?: Embedder; coverage?: boolean; pauseMs?: number } = {}) {
  const results = []
  for (const scenario of CASES) {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-memory-stress-'))
    const memory = new SqliteMemory({ dir, ...options })
    let turns: TurnIndex | undefined
    try {
      if (scenario.turns) {
        const historyDir = path.join(dir, 'history')
        mkdirSync(historyDir)
        const day = '2026-01-01'
        const lines = scenario.turns.map((turn, index) => JSON.stringify({
          ...turn, at: `${day}T00:00:0${index}.000Z`, kind: 'user',
        }))
        writeFileSync(path.join(historyDir, `${day}.jsonl`), `${lines.join('\n')}\n`)
        turns = new TurnIndex({ dir: historyDir })
      }
      // These are independently established facts; do not let lexical dedupe erase a correction.
      if (options.embedder && options.pauseMs) await delay(options.pauseMs)
      await memory.remember(INSTALL_SCOPE, scenario.notes.map((text) => ({ text, preserveDistinct: true })))
      await memory.whenEmbedded()
      const stored = (await memory.list(INSTALL_SCOPE, { limit: Number.MAX_SAFE_INTEGER })).length
      if (stored !== scenario.notes.length) throw new Error(`${scenario.name}: stored ${stored} of ${scenario.notes.length} notes`)
      if (options.embedder && options.pauseMs) await delay(options.pauseMs)
      const returned = (await installMemory(memory, turns).recall(INSTALL_SCOPE, scenario.query, { limit: 5 })).map((item) => item.text)
      const metrics = scoreReply(returned, scenario.answers)
      results.push({
        name: scenario.name,
        query: scenario.query,
        expected: scenario.answers,
        returned,
        ...metrics,
        passed: scenario.answers.length === 0 ? returned.length === 0 : metrics.recall === 1 && metrics.precision === 1,
      })
    } finally {
      turns?.close()
      memory.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  return results
}
