import { z } from 'zod'
import { readConfig } from '../config/load.js'
import { ConfigSchema } from '../config/schema.js'
import { applyConfigPatch, sanitizeConfig } from '../settings.js'
import type { Tool, ToolContext, ToolResult } from './types.js'

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('get'),
    section: z
      .string()
      .optional()
      .describe('Optional top-level config key to inspect (for example display, palette, sessions, memory, browser, permissions, verification, web, gateways, media, search, classifier).'),
  }),
  z.object({
    action: z.literal('set'),
    patch: z
      .record(z.string(), z.unknown())
      .describe('Partial config object merged section by section into config.yml. Use null to clear an optional key.'),
  }),
])

export type SettingsArgs = z.infer<typeof schema>

const TOP_LEVEL_KEYS = Object.keys(ConfigSchema.shape)

function getSettings(section?: string): ToolResult {
  const config = readConfig()
  if (!config) return { content: 'Milo is not configured yet.', isError: true }

  const sanitized = sanitizeConfig(config) as Record<string, unknown>
  const trimmed = section?.trim()
  if (!trimmed) {
    return { content: JSON.stringify(sanitized, null, 2) }
  }

  if (!TOP_LEVEL_KEYS.includes(trimmed)) {
    return {
      content: `Unknown settings section "${trimmed}". Valid sections: ${TOP_LEVEL_KEYS.join(', ')}.`,
      isError: true,
    }
  }

  const value = sanitized[trimmed]
  if (value === undefined) {
    return { content: `${trimmed}: (unset)` }
  }
  return { content: JSON.stringify({ [trimmed]: value }, null, 2) }
}

function setSettings(patch: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const keys = Object.keys(patch)
  if (keys.length === 0) {
    return { content: 'Provide at least one setting to update in patch.', isError: true }
  }
  if ('provider' in patch || 'providers' in patch) {
    return {
      content: 'Use the providers tool to add, edit, remove, or switch providers.',
      isError: true,
    }
  }

  const applied = applyConfigPatch(patch)
  if (!applied.ok) return { content: applied.error, isError: true }

  const { previous, next, changed, restartRequired } = applied.value
  ctx.settingsAdmin?.apply(previous, next)

  if (changed.length === 0) {
    return { content: 'No settings changed (already set to those values).' }
  }

  const summary = `Updated settings: ${changed.join(', ')}.`
  if (restartRequired.length > 0) {
    return { content: `${summary} Restart Milo to apply: ${restartRequired.join(', ')}.` }
  }
  return { content: summary }
}

export const settingsTool: Tool<SettingsArgs> = {
  name: 'settings',
  description:
    'Inspect ("get") or update ("set") Milo’s own settings in ~/.milo/config.yml — including display, palette, reasoningEffort, sessions, memory, history, traces, media, search, browser, computer, google, web, gateways, jobs, sandbox, verification, classifier, permissions, models, maxTokens, maxSteps, and systemPrompt. ' +
    'Pass a nested patch object to "set" (only the keys you mention change; pass null to clear an optional key). ' +
    'Use the `providers` tool instead for adding, testing, removing, or switching model providers, and never handle API keys or secrets here (those belong in Settings → API keys).',
  schema,
  readOnly: false,
  asksWhen: (args) => args.action !== 'get',
  async execute(args, ctx) {
    if (args.action === 'get') return getSettings(args.section)
    return setSettings(args.patch, ctx)
  },
}
