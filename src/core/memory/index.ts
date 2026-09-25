import type { Auth, Config, MemoryConfig } from '../config/schema.js'
import {
  DEFAULT_CLOUD_EMBED_MODEL,
  DEFAULT_LOCAL_EMBED_MODEL,
  OLLAMA_URL,
  OPENROUTER_URL,
} from '../config/schema.js'
import { resolveApiKey } from '../config/load.js'
import { logWarn } from '../../util/log.js'
import { createOllama, createOpenAiEmbeddings, type Embedder } from './embed.js'
import { SqliteMemory, sqliteMemoryFile, sqliteMemoryStatus } from './sqlite.js'
import {
  INSTALL_SCOPE,
  type Memory,
  type MemoryItem,
  type MemoryScope,
  type MemoryStatus,
  type TurnSource,
} from './types.js'

export * from './types.js'
export { DEFAULT_LIST_LIMIT, SqliteMemory } from './sqlite.js'
export { TurnIndex, turnIndexFile } from './turns.js'

/**
 * How many notes a question is answered from when nothing set it. Small on
 * purpose: recall rides every request, and a wide net costs tokens on every turn
 * to add notes the answer rarely turns on.
 */
export const DEFAULT_RECALL_LIMIT = 5

/**
 * The store: one SQLite file per machine holding the facts, recall by BM25 over
 * the notes and by meaning when an embedder is configured. What the person typed
 * is not in here — it is in the history log, indexed by `turns.ts` — so this file
 * holds only what the model decided was worth keeping, and nothing evicts it.
 */
export function createMemory(
  config: MemoryConfig,
  dir: string,
  options: { apiKey?: string } = {},
): Memory {
  return new SqliteMemory({
    dir,
    embedder: embedderFor(config.embedding, options.apiKey),
  })
}

/**
 * The embedder the config asks for, or nothing when it cannot have one.
 *
 * `ollama` is a model on this machine — Milo's own engine, or one already running
 * here. `openrouter` is one on theirs: nothing to download and no VRAM, because
 * the text leaves this machine to be turned into a vector.
 */
function embedderFor(embedding: MemoryConfig['embedding'], apiKey?: string): Embedder | undefined {
  if (!embedding) return undefined

  if (embedding.provider === 'openrouter') {
    if (!apiKey) {
      logWarn(
        'embeddings are set to OpenRouter and no key was found — recall keeps to words. Add one in `milo setup` → API keys',
      )
      return undefined
    }
    return createOpenAiEmbeddings({
      url: embedding.url ?? OPENROUTER_URL,
      model: embedding.model ?? DEFAULT_CLOUD_EMBED_MODEL,
      apiKey,
    })
  }

  return createOllama({
    url: embedding.url ?? OLLAMA_URL,
    model: embedding.model ?? DEFAULT_LOCAL_EMBED_MODEL,
  })
}

/**
 * The key a hosted embedder needs, resolved exactly as a chat provider's is — the
 * same OpenRouter key serves both, so one entry in `auth.json` is enough, and
 * someone who already talks to OpenRouter has nothing new to configure.
 */
export function embeddingKey(config: Config, auth: Auth): string | undefined {
  const entry = config.providers.openrouter ?? { baseURL: OPENROUTER_URL }
  const key = resolveApiKey('openrouter', entry, auth)
  return typeof key === 'string' ? key : undefined
}

/**
 * What is actually in the store, for the setup screen. Reads it off disk so the
 * screen needs no runtime — the same way it re-reads `auth.json` on navigation —
 * and creates nothing.
 */
export function memoryStatus(dir: string): MemoryStatus {
  return sqliteMemoryStatus(sqliteMemoryFile(dir))
}

/**
 * The memory an install actually gets: the whole machine reading and writing one
 * scope, so a fact saved in one surface is recalled in the others.
 *
 * A `Session` still passes the conversation it is in — that is what binds it to a
 * transcript — and the scope is dropped here, where the policy lives, rather
 * than inside the store. The day an install serves more than one person, this is
 * the function that picks whose memory a turn reads.
 *
 * Recall answers from both halves. Facts come first: they are what the model
 * decided was worth keeping, against turns that are a conversation's own record.
 * Turns fill what the facts leave, which is also what keeps a handful of durable
 * notes from being drowned by the last thing said.
 */
export function installMemory(
  memory: Memory,
  turns?: TurnSource,
  scope: MemoryScope = INSTALL_SCOPE,
): Memory {
  return {
    remember: (_conversation, items) => memory.remember(scope, items),
    recall: async (_conversation, query, opts) => {
      const limit = opts?.limit ?? DEFAULT_RECALL_LIMIT
      const facts = await memory.recall(scope, query, opts)
      if (!turns || facts.length >= limit) return facts.slice(0, limit)

      const said = await turns.recall(scope, query, { limit })
      return merge(facts, said, limit)
    },
    list: (_conversation, opts) => memory.list(scope, opts),
    forget: (_conversation, id) => memory.forget(scope, id),
  }
}

/**
 * Facts ahead of turns, with the same sentence never twice.
 *
 * A fact and the turn it was extracted from are the same words, and both would
 * otherwise claim a line of the block. Order is by position — facts keep the
 * front — and the scores are rewritten to match, so `1` is still the best note
 * of the reply the model is reading.
 */
function merge(facts: MemoryItem[], turns: MemoryItem[], limit: number): MemoryItem[] {
  const seen = new Set(facts.map((item) => item.text.trim().toLowerCase()))
  const merged = [...facts]

  for (const turn of turns) {
    if (merged.length >= limit) break
    const key = turn.text.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(turn)
  }

  return merged.slice(0, limit).map((item, index) => ({ ...item, score: 1 / (1 + index) }))
}
