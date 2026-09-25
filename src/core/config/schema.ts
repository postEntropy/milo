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

export const MemorySchema = z.object({
  backend: z.literal('file').default('file'),
})
export type MemoryConfig = z.infer<typeof MemorySchema>

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
})
export type SessionsConfig = z.infer<typeof SessionsSchema>

export const DEFAULT_SESSIONS: SessionsConfig = {
  compactAt: 0.7,
  maxInputTokens: 12000,
  keepTurns: 8,
  compaction: true,
}

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

export const ConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  providers: z.record(z.string(), ProviderEntrySchema),
  memory: MemorySchema.default({ backend: 'file' }),
  sessions: SessionsSchema.default(DEFAULT_SESSIONS),
  display: DisplaySchema.default(DEFAULT_DISPLAY),
  gateways: z.record(z.string(), GatewaySchema).default({}),
  permissions: PermissionsSchema.default(DEFAULT_PERMISSIONS),
  browser: BrowserSchema.default(DEFAULT_BROWSER),
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
   * each provider and model makes of an absent field. Anthropic's `thinking`
   * budget is a different shape and is not covered by this yet.
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
})
export type Auth = z.infer<typeof AuthSchema>

export const emptyAuth = (): Auth => ({ providers: {}, gateways: {}, search: {} })
