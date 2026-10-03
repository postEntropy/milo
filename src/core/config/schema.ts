import { z } from 'zod'
import { REASONING_EFFORTS, DEFAULT_REASONING_EFFORT } from '../providers/types.js'

export const WireSchema = z.enum(['openai', 'anthropic', 'auto'])
export type WireInput = z.infer<typeof WireSchema>

export const ProviderEntrySchema = z.object({
  name: z.string().optional(),
  baseURL: z.string(),
  wire: WireSchema.optional(),
  headers: z.record(z.string(), z.string()).optional(),
  keyless: z.boolean().optional(),
  keyEnv: z.string().optional(),
})
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>

/** Where a vector can come from: a model on this machine, or one on theirs. */
export const EMBED_PROVIDERS = ['ollama', 'openrouter'] as const
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number]

/**
 * The local default: multilingual and 593 MB, against bge-m3's 1.08 GB for a
 * little more quality. Recall by meaning is worth a small model; the heavier one
 * is a config edit away.
 */
export const DEFAULT_LOCAL_EMBED_MODEL = 'embeddinggemma'

/**
 * The hosted default: free, roomy, and the better of the two free routes when
 * measured — 8 notes, 32 questions: it answered 20 of 24 matching questions
 * against 18 for the 350M one, and its 32,768-token context takes a pasted turn
 * whole where the other refuses past 512.
 */
export const DEFAULT_CLOUD_EMBED_MODEL = 'nvidia/nemotron-3-embed-1b:free'

export const OLLAMA_URL = 'http://127.0.0.1:11434'
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1'

export const MemorySchema = z.object({
  /** How many notes a question is answered from. Absent means Milo's default. */
  recallLimit: z.number().int().positive().optional(),
  /**
   * Whether a finished turn is read for facts worth keeping. On by default: it
   * is what makes memory work without being asked, and it costs one model call
   * per turn, off the answer.
   */
  derive: z.boolean().default(true),
  /**
   * Recall by meaning. Absent means words only — the default, because it needs
   * an engine somewhere and nothing else in Milo does. `milo setup` → Memory
   * offers both ways: a model fetched onto this machine, or a keyed one that
   * runs on the provider's.
   */
  embedding: z
    .object({
      provider: z.enum(EMBED_PROVIDERS).default('ollama'),
      /** Absent means whichever model is the default for that provider. */
      model: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
})
export type MemoryConfig = z.infer<typeof MemorySchema>

/**
 * A config that says nothing about memory at all: what a first run writes, and
 * what a file predating the setting loads as. Derived from the schema so the
 * defaults are declared in exactly one place.
 */
export const DEFAULT_MEMORY: MemoryConfig = MemorySchema.parse({})

/**
 * The decision model a review is asked of, and how to reach it. Same shape as
 * `memory.embedding`: a provider, a url, a model. `commandcode` rides on the chat
 * provider (the hosted `typesafe/jev`); `ollaya` and `custom` are a TypeSafe-compatible
 * endpoint of their own, so the classifier no longer has to live where the chat does.
 */
export const CLASSIFIER_BACKENDS = ['commandcode', 'ollaya', 'custom'] as const
export type ClassifierBackend = (typeof CLASSIFIER_BACKENDS)[number]

/** The local decision-model daemon (Ollaya), TypeSafe-compatible on this base. */
export const OLLAYA_URL = 'http://127.0.0.1:11435/v1'
/** The recommended local model when there is a GPU; `laya` is the CPU one. */
export const OLLAYA_DEFAULT_MODEL = 'winnow:e4b'

export const ClassifierSchema = z.object({
  /** Where the decision model lives. `commandcode` rides on the chat provider. */
  backend: z.enum(CLASSIFIER_BACKENDS).default('commandcode'),
  /** The model to ask. Absent, each backend's own default. */
  model: z.string().optional(),
  /** For `ollaya`/`custom`: a TypeSafe-compatible base URL. Absent, Ollaya's default. */
  url: z.string().optional(),
  /** For `custom`: the env var holding the key. Ollaya needs any value. */
  keyEnv: z.string().optional(),
  /** Abort the review after this long, then fail closed to asking. */
  timeoutMs: z.number().int().positive().optional(),
})
export type ClassifierConfig = z.infer<typeof ClassifierSchema>

export const DEFAULT_CLASSIFIER: ClassifierConfig = { backend: 'commandcode' }

export const GatewaySchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * User/chat ids allowed to talk to the bot. An empty list means anyone can
   * (the default); a non-empty list fails closed for everyone else.
   */
  allowlist: z.array(z.string()).default([]),
})
export type GatewayConfig = z.infer<typeof GatewaySchema>

export const PermissionsSchema = z.object({
  mode: z.enum(['ask', 'auto', 'yolo']).default('ask'),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  /** In `auto` mode, allow when P(dangerous) is below this. */
  jevThreshold: z.number().min(0).max(1).default(0.35),
  /** Abort the review after this long (then fail closed to asking). */
  jevTimeoutMs: z.number().int().positive().default(1500),
})
export type PermissionsConfig = z.infer<typeof PermissionsSchema>

export const DEFAULT_PERMISSIONS: PermissionsConfig = {
  mode: 'ask',
  allow: [],
  deny: [],
  jevThreshold: 0.35,
  jevTimeoutMs: 1500,
}

export const SearchSchema = z.object({
  provider: z.enum(['tavily', 'exa', 'parallel']),
  keyEnv: z.string().optional(),
})
export type SearchConfig = z.infer<typeof SearchSchema>

export const SessionsSchema = z.object({
  /**
   * Compact once the request passes this share of the model's context window.
   * The window is looked up from public model metadata; a flat token ceiling is
   * meaningless without it — the same 12000 is a third of a small window and 1%
   * of a large one, and the second case compacts on every turn for nothing.
   */
  compactAt: z.number().gt(0).max(0.95).default(0.7),
  /** The model's window in tokens, for when the lookup is wrong or knows nothing. */
  contextWindow: z.number().int().positive().optional(),
  /** The ceiling used when the model's window is unknown. */
  maxInputTokens: z.number().int().positive().default(12000),
  /** Turns kept verbatim when compacting; the older ones get summarized. */
  keepTurns: z.number().int().positive().default(8),
  compaction: z.boolean().default(true),
  /**
   * How many sessions are kept on disk. Every run leaves one behind, so without
   * this the directory grows a file per run; the oldest beyond this are pruned at
   * startup, and one currently bound to a scope is never touched. `0` keeps every
   * one, the same way `history.windowDays` says "keep the lot" — pruning only ever
   * trims these working files, never the log that recall reads, so refusing to
   * prune costs disk and nothing else.
   */
  maxSessions: z.number().int().nonnegative().default(50),
})
export type SessionsConfig = z.infer<typeof SessionsSchema>

export const DEFAULT_SESSIONS: SessionsConfig = {
  compactAt: 0.7,
  maxInputTokens: 12000,
  keepTurns: 8,
  compaction: true,
  maxSessions: 50,
}

/**
 * The history log under `~/.milo/history`: one JSONL file per day, the record of
 * every turn that survives its session. Milo never trims it on its own — the log
 * is the honest shape for a record — so `milo history` reports what it costs and
 * `milo history trim` is the deliberate way to make it smaller.
 */
export const HistorySchema = z.object({
  /**
   * How far back recall reads the log. The index holds a window rather than a
   * cap: a window bounds the store while still reaching further back than the
   * 2,000-row cap it replaced, and older days are dropped rather than refused.
   * `0` keeps every day.
   */
  windowDays: z.number().int().nonnegative().default(365),
})
export type HistoryConfig = z.infer<typeof HistorySchema>

export const DEFAULT_HISTORY: HistoryConfig = { windowDays: 365 }

/**
 * Whether a surface shows the model's reasoning. `on` keeps the text under the
 * question it belongs to, `off` shows none of it. The model reasons either way —
 * this is display only. Deliberately not a "level": how much thinking happens
 * (and costs) is `reasoningEffort`, a different question from how much of it is
 * shown, and one word for both is how the two get confused.
 */
export const ThinkingDisplaySchema = z.enum(['off', 'on'])
export type ThinkingDisplay = z.infer<typeof ThinkingDisplaySchema>

/**
 * The setting has been a boolean and then a three-value level, and a config on
 * disk may still say `true`, `false`, `brief` or `full`. Refusing one would fail
 * the whole file and take every other setting with it, so the old forms are
 * translated: anything that showed the reasoning is `on`.
 */
const ThinkingDisplayValue = z
  .union([z.boolean(), z.enum(['off', 'on', 'brief', 'full'])])
  .transform((value): ThinkingDisplay => (value === false || value === 'off' ? 'off' : 'on'))

export const DisplaySchema = z.object({
  /**
   * How much of each tool call the surfaces show: the whole call with its
   * arguments, just the tool name, or no tool lines at all. A failure is always
   * shown — hiding that it went wrong is worse than the noise.
   */
  tools: z.enum(['full', 'name', 'off']).default('full'),
  thinking: ThinkingDisplayValue.default('on'),
})
export type DisplayConfig = z.infer<typeof DisplaySchema>

export const DEFAULT_DISPLAY: DisplayConfig = { tools: 'full', thinking: 'on' }

/**
 * The browser Milo drives. Off until it is turned on, like every other optional
 * capability — and off also means the tools are not registered at all, so the
 * model never sees three tools it has no browser for.
 */
export const BrowserSchema = z.object({
  enabled: z.boolean().default(false),
  /** An explicit binary; otherwise `MILO_BROWSER_CHROME`, then the usual places. */
  chromePath: z.string().nullable().default(null),
  headless: z.boolean().default(true),
  /**
   * Which profile the browser runs on. Left unset, Milo keeps its own under
   * `~/.milo/browser/profile/`. Point it at a copy of a real profile to reach
   * logged-in accounts — never at the browser's default directory, which Chrome
   * refuses to open for debugging without saying so.
   */
  profileDir: z.string().nullable().default(null),
  /**
   * Attach to a browser that is already running instead of starting one of our
   * own. Opt-in, because it means asking the person to enable remote debugging
   * in the browser they are actually using.
   */
  cdpUrl: z.string().nullable().default(null),
  /** How many page snapshots stay in the transcript; older ones become a line. */
  keepSnapshots: z.number().int().nonnegative().default(2),
})
export type BrowserConfig = z.infer<typeof BrowserSchema>

export const DEFAULT_BROWSER: BrowserConfig = {
  enabled: false,
  chromePath: null,
  headless: true,
  profileDir: null,
  cdpUrl: null,
  keepSnapshots: 2,
}

/**
 * The web UI: the browser chat `milo serve` starts beside the bots. On by
 * default, because a surface nobody can start is not really a surface; turn it
 * off here or with `milo serve --no-web` and the daemon serves the bots alone.
 *
 * `host` is where it binds. Leaving it on loopback is the point — anything else
 * is reachable from the network, and the token in the URL is then the only thing
 * between a stranger and the install.
 */
export const WebSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(7717),
})
export type WebConfig = z.infer<typeof WebSchema>

export const DEFAULT_WEB: WebConfig = { enabled: true, host: '127.0.0.1', port: 7717 }

/**
 * Google — Gmail and Drive. Off unless asked for, like every optional capability,
 * and there are no keys here: the app identity and the grant are credentials and
 * live in `auth.json` with the other secrets.
 *
 * `enabled` says the capability is wanted, not that it is connected. A wanted but
 * unconnected Google still registers its tools, which answer with the one thing
 * left to do (`milo google connect`) — an absent tool would be a silence.
 */
export const GoogleSchema = z.object({ enabled: z.boolean().default(false) })
export type GoogleConfig = z.infer<typeof GoogleSchema>
export const DEFAULT_GOOGLE: GoogleConfig = { enabled: false }

/** Optional model ids for image and document tasks, plus Groq's transcription model. */
export const MediaModelsSchema = z.object({
  vision: z.string().optional(),
  audio: z.string().default('whisper-large-v3-turbo'),
  document: z.string().optional(),
})
export type MediaModelsConfig = z.infer<typeof MediaModelsSchema>

/**
 * The grant Milo holds: the OAuth app it is, and the access it was given.
 *
 * `email` and `connectedAt` are notes for the person — `milo google status` says
 * who is connected without spending a call to find out.
 */
export const GoogleAccountSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  refreshToken: z.string().optional(),
  email: z.string().optional(),
  connectedAt: z.string().optional(),
})
export type GoogleAccount = z.infer<typeof GoogleAccountSchema>

export const ConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  providers: z.record(z.string(), ProviderEntrySchema),
  memory: MemorySchema.default(DEFAULT_MEMORY),
  sessions: SessionsSchema.default(DEFAULT_SESSIONS),
  history: HistorySchema.default(DEFAULT_HISTORY),
  display: DisplaySchema.default(DEFAULT_DISPLAY),
  gateways: z.record(z.string(), GatewaySchema).default({}),
  web: WebSchema.default(DEFAULT_WEB),
  permissions: PermissionsSchema.default(DEFAULT_PERMISSIONS),
  classifier: ClassifierSchema.default(DEFAULT_CLASSIFIER),
  browser: BrowserSchema.default(DEFAULT_BROWSER),
  google: GoogleSchema.default(DEFAULT_GOOGLE),
  media: MediaModelsSchema.optional(),
  search: SearchSchema.optional(),
  systemPrompt: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  /**
   * Output token ceiling per request. Left unset, each wire uses its own
   * default — 4096 on the Anthropic one, which is low enough to cut a long
   * answer or a `write_file` of a big file in half. Set it to whatever the
   * model actually supports.
   */
  maxTokens: z.number().int().positive().optional(),
  /**
   * How hard the model thinks before answering. Defaults to `medium`, so every
   * request carries an explicit effort instead of leaving the choice to whatever
   * each provider and model makes of an absent field. On the OpenAI wire it is
   * `reasoning_effort`; on the Anthropic wire the same effort is mapped to a
   * `thinking` token budget, and the thinking blocks are echoed back with it.
   */
  reasoningEffort: z.enum(REASONING_EFFORTS).default(DEFAULT_REASONING_EFFORT),
})
export type Config = z.infer<typeof ConfigSchema>

export const AuthSchema = z.object({
  providers: z.record(z.string(), z.string()).default({}),
  gateways: z.record(z.string(), z.string()).default({}),
  /**
   * One key per search provider, so switching providers does not send the old
   * provider's key to the new one. An unreadable value is dropped rather than
   * failing the whole file, which would take every other key with it.
   */
  search: z.record(z.string(), z.string()).catch({}).default({}),
  /** The Google grant, when one has been made: `milo google connect` writes it. */
  google: GoogleAccountSchema.optional(),
})
export type Auth = z.infer<typeof AuthSchema>

export const emptyAuth = (): Auth => ({ providers: {}, gateways: {}, search: {} })
