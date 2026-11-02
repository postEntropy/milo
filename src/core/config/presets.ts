import type { ProviderOAuth } from './schema.js'

export interface Preset {
  id: string
  name: string
  baseURL: string
  wire: 'openai' | 'anthropic' | 'responses' | 'auto'
  keyEnv?: string
  keyless?: boolean
  /** A sign-in instead of a key: the preset is offered once the grant exists. */
  oauth?: ProviderOAuth
  models: string[]
  keyURL?: string
}

export const PRESETS: Preset[] = [
  {
    id: 'commandcode',
    name: 'Command Code',
    baseURL: 'https://api.commandcode.ai/provider/v1',
    wire: 'auto',
    keyEnv: 'COMMANDCODE_API_KEY',
    keyURL: 'https://commandcode.ai/settings/keys',
    // Availability depends on the plan (needs something above Go).
    models: [
      'deepseek/deepseek-v4-flash',
      'gpt-5.6-luna',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1',
    wire: 'auto',
    keyEnv: 'OPENCODE_API_KEY',
    keyURL: 'https://opencode.ai/auth',
    // The gateway serves each family on its own endpoint: Claude ids on
    // `/messages` (auto), the rest on `/chat/completions`. Its GPT models live
    // on `/responses`, a wire this preset does not select, so they are left out.
    models: ['claude-sonnet-5', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k2.7-code'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    wire: 'openai',
    keyEnv: 'OPENROUTER_API_KEY',
    keyURL: 'https://openrouter.ai/keys',
    models: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    wire: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    keyURL: 'https://platform.openai.com/api-keys',
    models: ['gpt-5.4-mini'],
  },
  {
    // The Codex subscription, not the API: the ChatGPT backend speaks the
    // Responses wire, and the grant comes from `milo chatgpt login` rather than
    // a key. The model list is what a fresh install knows; with Codex on the
    // same machine the picker reads its own catalog instead.
    id: 'chatgpt',
    name: 'ChatGPT (Codex)',
    baseURL: 'https://chatgpt.com/backend-api/codex',
    wire: 'responses',
    oauth: 'chatgpt',
    models: [
      'gpt-6.1-terra',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-5.6-terra',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
      'gpt-6-luna',
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    wire: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyURL: 'https://console.anthropic.com/settings/keys',
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    wire: 'openai',
    keyless: true,
    models: ['llama3.3', 'qwen2.5', 'mistral'],
  },
]

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id)
}
