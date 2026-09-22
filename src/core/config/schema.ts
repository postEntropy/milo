import { z } from 'zod'

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
  /** Compact the transcript once it grows past this many estimated tokens. */
  maxInputTokens: z.number().int().positive().default(12000),
  /** Turns kept verbatim when compacting; the older ones get summarized. */
  keepTurns: z.number().int().positive().default(8),
  compaction: z.boolean().default(true),
})
export type SessionsConfig = z.infer<typeof SessionsSchema>

export const DEFAULT_SESSIONS: SessionsConfig = {
  maxInputTokens: 12000,
  keepTurns: 8,
  compaction: true,
}

export const DisplaySchema = z.object({
  /**
   * How much of each tool call the surfaces show: the whole call with its
   * arguments, just the tool name, or no tool lines at all. A failure is always
   * shown — hiding that it went wrong is worse than the noise.
   */
  tools: z.enum(['full', 'name', 'off']).default('full'),
  /**
   * Show the model's reasoning: a live pane in the CLI, one line on a chat
   * surface (the whole thing would crowd out the answer in a single message).
   */
  thinking: z.boolean().default(true),
})
export type DisplayConfig = z.infer<typeof DisplaySchema>

export const DEFAULT_DISPLAY: DisplayConfig = { tools: 'full', thinking: true }

export const ConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  providers: z.record(z.string(), ProviderEntrySchema),
  memory: MemorySchema.default({ backend: 'file' }),
  sessions: SessionsSchema.default(DEFAULT_SESSIONS),
  display: DisplaySchema.default(DEFAULT_DISPLAY),
  gateways: z.record(z.string(), GatewaySchema).default({}),
  permissions: PermissionsSchema.default(DEFAULT_PERMISSIONS),
  search: SearchSchema.optional(),
  systemPrompt: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
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
