import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import type { Embedder } from '../../src/core/memory/embed.js'
import { INSTALL_SCOPE, installMemory } from '../../src/core/memory/index.js'
import { SqliteMemory, type SqliteMemoryOptions } from '../../src/core/memory/sqlite.js'
import { TurnIndex } from '../../src/core/memory/turns.js'
import type { Memory, MemoryItem } from '../../src/core/memory/types.js'

/**
 * The recall eval set: the notes a Milo install would hold, the questions a
 * person actually asks of them, and which note answers each one.
 *
 * It exists because every recall measurement in this repo used to be run by hand
 * once — 8 notes, 32 questions, a number in a code comment. A comment cannot be
 * re-run, so "reordering the candidates would help" and "a cut-off hurts" were
 * opinions with a single measurement behind them. This is the same judgement
 * written down where a script can score it, and where a change that makes recall
 * worse shows up as a number going the wrong way.
 *
 * The notes are deliberately hostile to a keyword store, because a store that
 * only works on tidy examples is not measured:
 *
 * - pairs that share every important word and mean different things ("o deploy
 *   do servidor" against "o deploy do site", the Telegram gateway against the
 *   Discord one) — the case where the right note is in the list but the tail is
 *   full of notes that merely share a word, which is what the coverage rule is
 *   for;
 * - one question per note with no word in common with it ("qual ferramenta eu
 *   abro pra programar?" against a note about Neovim) — reachable by meaning
 *   only, and honest about it: keyword recall misses it;
 * - filler that shares a word with everything ("Uso tmux", "Uso mise"), so a
 *   single shared word is not enough to win;
 * - Portuguese and English mixed, and accented words, the way one install is.
 *
 * And the questions that must reach nothing at all, which is where recall hurts
 * most: a store with an embedder always returns its nearest notes, so "qual a
 * capital da França?" coming back with the editor note is a live, measured
 * failure rather than a hypothetical one.
 */
export const NOTES: string[] = [
  'Meu editor e o Neovim.',
  'Prefiro respostas em bullet points, bem resumidas.',
  'Uso tmux para dividir o terminal em paineis.',
  'Moro em Sao Paulo e trabalho no fuso de Brasilia.',
  'Meu nome e Leonardo e prefiro ser chamado de Leo.',
  'Nao gosto de acucar no cafe, so leite.',
  'Toco guitarra nos fins de semana.',
  'Meu teclado e um Corne com layout Colemak.',
  'Prefiro TypeScript a JavaScript em qualquer projeto novo.',
  'Uso mise para gerenciar as versoes do Node.',
  'Sempre escrevo os testes antes do codigo.',
  'No Milo a memoria vive num unico arquivo SQLite, o memory.db.',
  'A tag de release do Milo e publicada na sexta-feira.',
  'O deploy do servidor roda as 3 da manha.',
  'O deploy do site roda as 5 da tarde.',
  'O banco de producao fica em db.prod.internal.',
  'O banco de staging e recriado toda segunda.',
  'O time usa Conventional Commits nas mensagens.',
  'O CI roda em Node 22 e Node 24.',
  'O orcamento de latencia do recall e de um milissegundo.',
  'A busca usa BM25 sobre uma tabela FTS5.',
  'Os embeddings rodam num Ollama local na porta 11434.',
  'O gateway do Telegram usa a biblioteca grammY.',
  'O gateway do Discord usa a biblioteca discord.js.',
  'A senha do servidor de banco gira toda segunda-feira.',
  'O provedor padrao de busca e o Exa.',
  'O provedor Tavily tem mil creditos gratis por mes.',
  'As sessoes sao salvas em um arquivo JSON por sessao.',
  'O historico e um JSONL por dia, append-only.',
  'A janela de contexto vem do catalogo do OpenRouter.',
  'O editor de texto do painel de admin e um componente React.',
  'Ja testei o VS Code, mas achei pesado demais.',
  'O servidor de staging fica desligado nos fins de semana.',
  'Prefiro cafe sem acucar, mas aceito cha com acucar.',
  'O Node 26 quebrou um teste de fuso horario.',
  'O recall roda antes de cada turno e nao pode custar caro.',
]

/**
 * What the person typed, in the log the turns half of recall reads.
 *
 * Two of these are real answers — a decision that was never saved as a fact, and
 * a preference said in passing. The rest is the background a recall has to not
 * be fooled by: greetings, a thank-you, and three questions that share their
 * words with the very notes they are asking about.
 */
export const TURNS: string[] = [
  'bom dia, tudo certo por ai?',
  'como eu configuro o tmux pra abrir dois paineis?',
  'lembra que a gente decidiu cortar o modo brief?',
  'voce pode revisar o PR quando puder?',
  'o deploy quebrou ontem de noite, era o cache',
  'qual era mesmo o nome daquele gateway do telegram?',
  'obrigado!',
  'bora de numero 2',
  'o teste de fuso horario falhou de novo aqui',
  'anota ai que eu odeio YAML',
]

export interface Question {
  query: string
  /** The exact texts that answer it — one of them is enough. */
  answers: string[]
}

export const QUESTIONS: Question[] = [
  { query: 'qual editor eu uso?', answers: ['Meu editor e o Neovim.'] },
  {
    query: 'como voce deve formatar as respostas?',
    answers: ['Prefiro respostas em bullet points, bem resumidas.'],
  },
  { query: 'que horas roda o deploy do servidor?', answers: ['O deploy do servidor roda as 3 da manha.'] },
  { query: 'que horas roda o deploy do site?', answers: ['O deploy do site roda as 5 da tarde.'] },
  {
    query: 'quando sai a tag de release do milo?',
    answers: ['A tag de release do Milo e publicada na sexta-feira.'],
  },
  { query: 'onde fica o banco de producao?', answers: ['O banco de producao fica em db.prod.internal.'] },
  {
    query: 'que linguagem eu prefiro usar?',
    answers: ['Prefiro TypeScript a JavaScript em qualquer projeto novo.'],
  },
  {
    query: 'qual o padrao de mensagem de commit do time?',
    answers: ['O time usa Conventional Commits nas mensagens.'],
  },
  { query: 'o que eu uso pra dividir o terminal?', answers: ['Uso tmux para dividir o terminal em paineis.'] },
  { query: 'qual e o meu nome?', answers: ['Meu nome e Leonardo e prefiro ser chamado de Leo.'] },
  {
    query: 'como eu gerencio as versoes do node?',
    answers: ['Uso mise para gerenciar as versoes do Node.'],
  },
  { query: 'que teclado eu uso?', answers: ['Meu teclado e um Corne com layout Colemak.'] },
  {
    query: 'qual e o orcamento de latencia do recall?',
    answers: ['O orcamento de latencia do recall e de um milissegundo.'],
  },
  {
    query: 'em que porta rodam os embeddings?',
    answers: ['Os embeddings rodam num Ollama local na porta 11434.'],
  },
  {
    query: 'qual biblioteca o gateway do telegram usa?',
    answers: ['O gateway do Telegram usa a biblioteca grammY.'],
  },
  {
    query: 'qual biblioteca o gateway do discord usa?',
    answers: ['O gateway do Discord usa a biblioteca discord.js.'],
  },
  {
    query: 'quando a senha do banco gira?',
    answers: ['A senha do servidor de banco gira toda segunda-feira.'],
  },
  {
    query: 'qual provedor de busca esta configurado?',
    answers: ['O provedor padrao de busca e o Exa.'],
  },
  {
    query: 'como as sessoes sao salvas?',
    answers: ['As sessoes sao salvas em um arquivo JSON por sessao.'],
  },
  { query: 'como o historico e gravado?', answers: ['O historico e um JSONL por dia, append-only.'] },
  {
    query: 'de onde vem a janela de contexto?',
    answers: ['A janela de contexto vem do catalogo do OpenRouter.'],
  },
  {
    query: 'o que roda antes de cada turno?',
    answers: ['O recall roda antes de cada turno e nao pode custar caro.'],
  },
  { query: 'em que versoes de node o ci roda?', answers: ['O CI roda em Node 22 e Node 24.'] },
  {
    query: 'onde fica a memoria do milo?',
    answers: ['No Milo a memoria vive num unico arquivo SQLite, o memory.db.'],
  },
  { query: 'o que a gente decidiu cortar?', answers: ['lembra que a gente decidiu cortar o modo brief?'] },
  { query: 'o que eu odeio?', answers: ['anota ai que eu odeio YAML'] },
  {
    query: 'o que eu faco antes de escrever codigo?',
    answers: ['Sempre escrevo os testes antes do codigo.'],
  },
  {
    query: 'quanto de credito gratis o tavily tem?',
    answers: ['O provedor Tavily tem mil creditos gratis por mes.'],
  },
  {
    query: 'onde ficam os arquivos de sessao?',
    answers: ['As sessoes sao salvas em um arquivo JSON por sessao.'],
  },
  {
    query: 'o que quebrou o teste de fuso horario?',
    answers: ['O Node 26 quebrou um teste de fuso horario.'],
  },
  { query: 'por que o deploy falhou ontem?', answers: ['o deploy quebrou ontem de noite, era o cache'] },
  {
    query: 'onde o servidor de staging fica desligado?',
    answers: ['O servidor de staging fica desligado nos fins de semana.'],
  },
  // No word in common with its answer: only a store that reads by meaning can
  // reach it, and a keyword-only run is expected to miss it.
  { query: 'qual ferramenta eu abro pra programar?', answers: ['Meu editor e o Neovim.'] },
]

/**
 * The same notes, asked in the asker's own words.
 *
 * The set above was written by the same hand as the notes, so it shares their
 * vocabulary — which flatters a word-matching store and is not how anyone talks.
 * These are the questions a person asks who does not already know what the note
 * says: "qual IDE eu adotei" against a note that says Neovim, "qual e o meu
 * hobby" against a note that says guitarra. None of them deliberately shares a
 * content word with the note that answers it.
 *
 * This is the axis the set above could not measure — one of its thirty-three
 * questions is of this kind, and it is the only one a keyword store misses — and
 * it is the one an embedding is *for*. A store of words is expected to fail
 * nearly all of it, and that number is the reason to pay for meaning at all. So
 * it is a score and not a pass/fail, and it is why `test/memory-eval.test.ts`
 * asserts nothing about it: the difference only appears with a model, and a test
 * that needs the network is not a floor anything can stand on.
 */
export const REWORDED: Question[] = [
  { query: 'qual IDE eu adotei pra programar', answers: ['Meu editor e o Neovim.'] },
  { query: 'qual e o meu hobby', answers: ['Toco guitarra nos fins de semana.'] },
  {
    query: 'qual hardware eu uso pra digitar',
    answers: ['Meu teclado e um Corne com layout Colemak.'],
  },
  { query: 'como eu tomo meu expresso', answers: ['Nao gosto de acucar no cafe, so leite.'] },
  {
    query: 'qual a minha cidade e o meu horario',
    answers: ['Moro em Sao Paulo e trabalho no fuso de Brasilia.'],
  },
  {
    query: 'quando trocam a password do db',
    answers: ['A senha do servidor de banco gira toda segunda-feira.'],
  },
  { query: 'qual o endereco do database', answers: ['O banco de producao fica em db.prod.internal.'] },
  {
    query: 'que servico transforma texto em vetor',
    answers: ['Os embeddings rodam num Ollama local na porta 11434.'],
  },
  { query: 'qual runtime a esteira usa', answers: ['O CI roda em Node 22 e Node 24.'] },
  {
    query: 'quando sai a versao nova',
    answers: ['A tag de release do Milo e publicada na sexta-feira.'],
  },
  { query: 'como o registro e gravado', answers: ['O historico e um JSONL por dia, append-only.'] },
  {
    query: 'onde ficam as conversas guardadas',
    answers: ['As sessoes sao salvas em um arquivo JSON por sessao.'],
  },
  {
    query: 'qual linguagem eu escolhi',
    answers: ['Prefiro TypeScript a JavaScript em qualquer projeto novo.'],
  },
]

/**
 * Questions nothing in the store answers. A store that returns its nearest notes
 * anyway is not "recalling" — it is spending five lines of every prompt on noise,
 * and the model has to read past it to notice there was nothing to remember.
 */
export const UNANSWERABLE: string[] = [
  'qual e a capital da Franca?',
  'quem ganhou a copa de 1994?',
  'como faco um bolo de cenoura?',
  'qual a previsao do tempo pra amanha?',
  'quem escreveu Dom Casmurro?',
  'qual a altura do Cristo Redentor?',
  'como se diz obrigatorio em japones?',
  'quanto custa o quilo do tomate?',
]

/** What a turn is answered from, which is also the width everything is scored at. */
export const EVAL_LIMIT = 5

export type Recall = (query: string, limit: number) => Promise<MemoryItem[]>

export interface Metrics {
  /** Questions with an answer in the store. */
  questions: number
  /** Relevant notes in the reply, over the size of the reply. */
  precision: number
  /** Relevant notes in the reply, over the notes that should have been there. */
  recall: number
  /** 1 over the rank of the first relevant note, averaged. */
  mrr: number
  /** The share of unanswerable questions that came back with something. */
  falsePositiveRate: number
  /**
   * How many of `REWORDED` came back at all, as a count: with thirteen of them,
   * `2/13` says more than `15.4%` does.
   */
  reworded: number
  /** Median recall latency, in milliseconds — the budget the coverage rule spends. */
  latencyMs: number
}

const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

/** How one reply scored: what was returned, against what should have been. */
export function scoreReply(
  recalled: string[],
  answers: string[],
): { precision: number; recall: number; mrr: number } {
  const wanted = new Set(answers.map(normalize))
  const returned = recalled.map(normalize)
  const hits = returned.filter((text) => wanted.has(text)).length

  const first = returned.findIndex((text) => wanted.has(text))
  return {
    precision: returned.length === 0 ? 0 : hits / returned.length,
    recall: wanted.size === 0 ? 0 : hits / wanted.size,
    mrr: first < 0 ? 0 : 1 / (first + 1),
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

export interface EvalOptions {
  /**
   * Wait after each question.
   *
   * One question is one embedding request, so this paces a model on a free tier
   * (twenty a minute) — and it sits *outside* the measured call on purpose. A
   * pause taken inside it lands in the latency the table reports, which is how a
   * row was once printed as three and a half seconds when the model took a
   * third of one.
   */
  pauseMs?: number
}

/**
 * What a run produced, before anything is scored.
 *
 * Split from `score` so a store that answers over some other wire — a provider
 * driven from another process, say — can be held to the same ruler without a
 * second aggregation living beside this one and drifting from it.
 */
export interface Collected {
  /** What came back for each of `QUESTIONS`, in order. */
  replies: string[][]
  /** How many notes came back for each of `UNANSWERABLE`, in order. */
  unanswerable: number[]
  /** Whether the answer came back for each of `REWORDED`, in order. */
  reworded: boolean[]
  /** How long each question took, in milliseconds — the half a provider pays too. */
  latencies: number[]
}

/**
 * Scores a collected run.
 *
 * The averages are macro — one question, one vote — so a question with several
 * answering notes does not weigh more than one with a single note.
 */
export function score(collected: Collected): Metrics {
  const counts = [
    [collected.replies.length, QUESTIONS.length, 'questions'],
    [collected.unanswerable.length, UNANSWERABLE.length, 'unanswerable'],
    [collected.reworded.length, REWORDED.length, 'reworded'],
  ] as const
  for (const [got, want, what] of counts) {
    // A run that answered part of the set is not a score, it is a partial run,
    // and averaging it would quietly report a better or worse number than the
    // one that actually happened.
    if (got !== want) throw new Error(`collected ${got} of ${want} ${what}`)
  }

  let precision = 0
  let hitRate = 0
  let mrr = 0
  QUESTIONS.forEach((question, index) => {
    const scored = scoreReply(collected.replies[index]!, question.answers)
    precision += scored.precision
    hitRate += scored.recall
    mrr += scored.mrr
  })

  return {
    questions: QUESTIONS.length,
    precision: precision / QUESTIONS.length,
    recall: hitRate / QUESTIONS.length,
    mrr: mrr / QUESTIONS.length,
    falsePositiveRate:
      collected.unanswerable.filter((count) => count > 0).length / UNANSWERABLE.length,
    reworded: collected.reworded.filter(Boolean).length,
    latencyMs: percentile(collected.latencies, 50),
  }
}

/** Asks the whole set of a recall function and collects what it says. */
export async function collect(
  recall: Recall,
  limit = EVAL_LIMIT,
  options: EvalOptions = {},
): Promise<Collected> {
  const collected: Collected = { replies: [], unanswerable: [], reworded: [], latencies: [] }

  const timed = async (query: string): Promise<string[]> => {
    const started = performance.now()
    const items = await recall(query, limit)
    collected.latencies.push(performance.now() - started)
    if (options.pauseMs) await delay(options.pauseMs)
    return items.map((item) => item.text)
  }

  for (const question of QUESTIONS) collected.replies.push(await timed(question.query))
  for (const query of UNANSWERABLE) collected.unanswerable.push((await timed(query)).length)
  // Asked in other words: scored as "did the note come back at all", because a
  // first-relevant-rank number over thirteen questions says less than the count.
  for (const question of REWORDED) {
    collected.reworded.push(scoreReply(await timed(question.query), question.answers).recall > 0)
  }

  return collected
}

/** Collects and scores in one call: what every in-process comparison uses. */
export async function runEval(
  recall: Recall,
  limit = EVAL_LIMIT,
  options: EvalOptions = {},
): Promise<Metrics> {
  return score(await collect(recall, limit, options))
}

export interface SeedOptions {
  /** Where to build the store. A fresh temp dir when none is given. */
  dir?: string
  embedder?: Embedder
  /** Whether the history log half is seeded at all. On by default. */
  turns?: boolean
  /** Knobs passed straight to the facts store — the options under test. */
  memory?: Partial<SqliteMemoryOptions>
}

export interface SeededStore {
  memory: Memory
  /** The notes the store actually kept, which a dedupe can make fewer than seeded. */
  facts: number
  close(): void
}

/** A store holding the eval set, the way an install that had lived a while would. */
export async function seedEvalStore(options: SeedOptions = {}): Promise<SeededStore> {
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), 'milo-eval-'))
  const facts = new SqliteMemory({
    embedder: options.embedder,
    ...options.memory,
    dir: path.join(dir, 'memory'),
  })

  await facts.remember(
    INSTALL_SCOPE,
    NOTES.map((text) => ({ text })),
  )
  // The vectors are filled in behind the write, so a semantic run would otherwise
  // score whichever notes happened to be embedded already.
  await facts.whenEmbedded()

  let turns: TurnIndex | undefined
  if (options.turns !== false) {
    const logDir = path.join(dir, 'history')
    seedLog(logDir, TURNS)
    turns = new TurnIndex({ dir: logDir })
  }

  return {
    memory: installMemory(facts, turns),
    facts: NOTES.length,
    close: () => {
      facts.close()
      turns?.close()
    },
  }
}

/** One day-file of turns, the shape the log actually grows in. */
function seedLog(dir: string, texts: string[]): void {
  mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const lines = texts.map((text, index) =>
    JSON.stringify({
      at: new Date(Date.now() - index * 60_000).toISOString(),
      session: 'calm-otter-7',
      scope: 'cli:main',
      kind: 'user',
      text,
    }),
  )
  writeFileSync(path.join(dir, `${day}.jsonl`), `${lines.join('\n')}\n`)
}
