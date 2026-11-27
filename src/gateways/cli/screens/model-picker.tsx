import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'
import { errorMessage } from '../../../util/errors.js'
import { openBrowser } from '../../../util/terminal.js'
import { readAuth, readConfig, resolveApiKey, saveAuth, saveConfig } from '../../../core/config/load.js'
import { PRESETS, type Preset } from '../../../core/config/presets.js'
import { ConfigSchema, type Config, type ProviderEntry, type WireInput } from '../../../core/config/schema.js'
import { RESERVED_PROVIDER_IDS, isCustomProviderId, slugifyProviderId } from '../../../core/settings.js'
import { beginChatGptBrowserLogin, type ChatGptLogin } from '../../../core/chatgpt/auth.js'
import { chatGptModels } from '../../../core/chatgpt/models.js'
import { listModels, type ModelInfo } from '../../../core/providers/models.js'
import { modelNote } from '../../model-label.js'
import { MiloMark } from '../components/milo-mark.js'
import { isCtrlC } from '../keys.js'
import { theme as defaultTheme, type TuiTheme } from '../theme.js'

type Step = 'provider' | 'customName' | 'customUrl' | 'customWire' | 'key' | 'login' | 'loading' | 'models' | 'manual'

interface PickerProvider extends Preset {
  custom?: boolean
  addNew?: boolean
}

const ADD_CUSTOM_ID = '__add_custom__'

const WIRE_CHOICES: ReadonlyArray<{ id: WireInput; label: string; hint: string }> = [
  { id: 'openai', label: 'OpenAI-compatible', hint: '/chat/completions' },
  { id: 'anthropic', label: 'Anthropic', hint: '/messages' },
  { id: 'responses', label: 'OpenAI Responses', hint: '/responses' },
  { id: 'auto', label: 'Auto', hint: 'Anthropic for Claude, OpenAI otherwise' },
]

const VISIBLE_ROWS = 12

function nextCustomId(name: string, existing: Record<string, ProviderEntry>): string {
  const base = slugifyProviderId(name) || 'custom'
  if (!RESERVED_PROVIDER_IDS.has(base) && !(base in existing)) return base
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!RESERVED_PROVIDER_IDS.has(candidate) && !(candidate in existing)) return candidate
  }
}

export interface ModelPickerProps {
  current?: { provider: string; model: string }
  theme?: TuiTheme
  onDone: (config: Config) => void
  onCancel?: () => void
}

export function ModelPicker({ current, theme: activeTheme = defaultTheme, onDone, onCancel }: ModelPickerProps) {
  const choices = useMemo<PickerProvider[]>(() => {
    const existing = readConfig()?.providers ?? {}
    const custom: PickerProvider[] = Object.entries(existing)
      .filter(([id]) => isCustomProviderId(id))
      .map(([id, entry]) => ({
        id,
        name: entry.name ?? id,
        baseURL: entry.baseURL,
        wire: entry.wire ?? 'openai',
        keyless: entry.keyless,
        keyEnv: entry.keyEnv,
        models: [],
        custom: true,
      }))
    return [
      ...PRESETS,
      ...custom,
      { id: ADD_CUSTOM_ID, name: '+ Add custom provider', baseURL: '', wire: 'openai', models: [], addNew: true },
    ]
  }, [])

  const [step, setStep] = useState<Step>('provider')
  const [index, setIndex] = useState(() => {
    const found = choices.findIndex((preset) => preset.id === current?.provider)
    return found >= 0 ? found : 0
  })
  const [customName, setCustomName] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customWireIndex, setCustomWireIndex] = useState(0)
  const [customKeyless, setCustomKeyless] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)

  const preset: PickerProvider = choices[index] ?? choices[0]!
  const activeName = preset.addNew ? customName.trim() : preset.name
  const activeBaseURL = preset.addNew ? customUrl.trim().replace(/\/+$/, '') : preset.baseURL
  const activeWire: WireInput = preset.addNew ? (WIRE_CHOICES[customWireIndex]?.id ?? 'openai') : preset.wire
  const activeKeyless = preset.addNew ? customKeyless : Boolean(preset.keyless)
  const apiKeyValue = activeKeyless ? false : apiKey.trim() || undefined

  useEffect(() => {
    if (step !== 'loading') return
    const controller = new AbortController()
    let cancelled = false

    void (async () => {
      try {
        // The ChatGPT backend serves no catalog; Codex's own cache is the one
        // that knows what the subscription currently offers.
        const list =
          preset.oauth === 'chatgpt'
            ? chatGptModels()
            : await listModels({
                baseURL: activeBaseURL,
                wire: activeWire,
                apiKey: apiKeyValue,
                signal: controller.signal,
              })
        if (cancelled) return
        if (list.length > 0) {
          setModels(list)
          setFilter('')
          setSelected(0)
          setStep('models')
        } else {
          setNotice('The provider returned no models — type one manually.')
          setManualModel(current?.model ?? preset.models[0] ?? '')
          setStep('manual')
        }
      } catch (error) {
        if (cancelled) return
        setNotice(`Could not fetch models (${errorMessage(error)}). Type one manually.`)
        setManualModel(current?.model ?? preset.models[0] ?? '')
        setStep('manual')
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [step, activeBaseURL, activeWire, preset.oauth, preset.models[0], apiKeyValue, current?.model])

  useEffect(() => {
    if (step !== 'login') return
    let cancelled = false
    let pending: ChatGptLogin | undefined

    void (async () => {
      try {
        pending = await beginChatGptBrowserLogin()
        if (cancelled) {
          pending.cancel()
          return
        }
        setLoginUrl(pending.url)
        openBrowser(pending.url)
        const account = await pending.wait
        if (cancelled) return
        setNotice(`Signed in as ${account.email ?? 'your account'}.`)
        setStep('loading')
      } catch (error) {
        if (cancelled) return
        setNotice(errorMessage(error))
        setStep('provider')
      }
    })()

    return () => {
      cancelled = true
      pending?.cancel()
    }
  }, [step])

  const filtered = models.filter((model) => {
    const haystack = `${model.id} ${model.name ?? ''}`.toLowerCase()
    return haystack.includes(filter.toLowerCase())
  })
  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1))

  const presetEntry = (): ProviderEntry => ({
    name: preset.name,
    baseURL: preset.baseURL,
    wire: preset.wire,
    keyless: preset.keyless,
    keyEnv: preset.keyEnv,
    ...(preset.oauth ? { oauth: preset.oauth } : {}),
  })

  useInput((_input, key) => {
    if (isCtrlC(_input, key)) {
      onCancel?.()
      return
    }

    if (step === 'provider') {
      if (key.upArrow) setIndex((value) => (value - 1 + choices.length) % choices.length)
      else if (key.downArrow) setIndex((value) => (value + 1) % choices.length)
      else if (key.return) {
        if (preset.addNew) {
          setCustomName('')
          setCustomUrl('')
          setCustomWireIndex(0)
          setCustomKeyless(false)
          setApiKey('')
          setNotice(null)
          setStep('customName')
          return
        }
        setCustomKeyless(false)
        setNotice(null)
        const signedIn = preset.oauth === 'chatgpt' ? Boolean(readAuth().chatgpt) : false
        const resolved = resolveApiKey(preset.id, presetEntry(), readAuth())
        if (typeof resolved === 'string') setApiKey(resolved)
        const hasKey = Boolean(resolved)
        if (preset.oauth === 'chatgpt' && !signedIn) setStep('login')
        else setStep(preset.keyless || hasKey || signedIn ? 'loading' : 'key')
      } else if (key.escape) onCancel?.()
      return
    }
    if (step === 'customName') {
      if (key.escape) {
        setNotice(null)
        setStep('provider')
      }
      return
    }
    if (step === 'customUrl') {
      if (key.escape) {
        setNotice(null)
        setStep('customName')
      }
      return
    }
    if (step === 'customWire') {
      if (key.upArrow) setCustomWireIndex((value) => (value - 1 + WIRE_CHOICES.length) % WIRE_CHOICES.length)
      else if (key.downArrow) setCustomWireIndex((value) => (value + 1) % WIRE_CHOICES.length)
      else if (key.return) {
        setNotice(null)
        setStep('key')
      } else if (key.escape) {
        setNotice(null)
        setStep('customUrl')
      }
      return
    }
    if (step === 'models') {
      if (key.upArrow) setSelected((value) => Math.max(0, value - 1))
      else if (key.downArrow) setSelected((value) => Math.min(filtered.length - 1, value + 1))
      else if (key.escape) onCancel?.()
      return
    }
    if (step === 'key' && key.escape) {
      if (preset.addNew) {
        setNotice(null)
        setStep('customWire')
      } else onCancel?.()
      return
    }
    if ((step === 'manual' || step === 'login') && key.escape) onCancel?.()
  })

  const submitCustomName = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
      setNotice('Enter a provider name.')
      return
    }
    if (/[\r\n]/.test(trimmed)) {
      setNotice('A provider name must fit on one line.')
      return
    }
    setNotice(null)
    setCustomName(trimmed)
    setStep('customUrl')
  }

  const submitCustomUrl = (value: string) => {
    const trimmed = value.trim()
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setNotice('Enter a valid http:// or https:// endpoint URL.')
        return
      }
    } catch {
      setNotice('Enter a valid http:// or https:// endpoint URL.')
      return
    }
    setNotice(null)
    setCustomUrl(trimmed.replace(/\/+$/, ''))
    setStep('customWire')
  }

  const submitKey = (value: string) => {
    if (preset.addNew) {
      const trimmed = value.trim()
      setCustomKeyless(!trimmed)
      setApiKey(trimmed)
    }
    setNotice(null)
    setStep('loading')
  }

  const finish = (chosen: string) => {
    const model = chosen.trim() || preset.models[0] || 'default'
    const existing = readConfig()
    const targetId = preset.addNew
      ? nextCustomId(activeName, existing?.providers ?? {})
      : preset.id

    if (!activeKeyless && apiKey.trim()) {
      const auth = readAuth()
      auth.providers[targetId] = apiKey.trim()
      saveAuth(auth)
    }

    // Built from what is on disk, not from the defaults: a file that already
    // exists may hold settings this screen has never heard of, and an object
    // assembled from scratch would drop them — and take every comment with them,
    // which is the whole reason the config is YAML. `ConfigSchema.parse` is what
    // supplies the defaults on a first run, when there is nothing on disk yet.
    const existingEntry = existing?.providers?.[targetId]
    const entry: ProviderEntry = preset.addNew
      ? {
          name: activeName,
          baseURL: activeBaseURL,
          wire: activeWire,
          ...(activeKeyless ? { keyless: true } : {}),
        }
      : {
          ...(existingEntry?.headers ? { headers: existingEntry.headers } : {}),
          ...(existingEntry?.nativePdf !== undefined ? { nativePdf: existingEntry.nativePdf } : {}),
          ...presetEntry(),
        }
    const config: Config = ConfigSchema.parse({
      ...(existing ?? {}),
      provider: targetId,
      model,
      providers: { ...(existing?.providers ?? {}), [targetId]: entry },
    })

    saveConfig(config)
    onDone(config)
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      <Box marginBottom={1} flexDirection="column">
        <Box gap={2}>
          <MiloMark compact theme={activeTheme} />
          <Text bold>{current ? 'Change provider / model' : 'First-run setup'}</Text>
        </Box>
        <Text color={activeTheme.muted}>
          {current
            ? 'Esc to cancel and go back to the chat.'
            : 'Configure your model provider — first-run setup. You can change it later with /model.'}
        </Text>
      </Box>

      {step === 'provider' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>Choose a provider</Text>
            <Text color={activeTheme.muted}> · ↑/↓ move · Enter select · Esc cancel</Text>
          </Box>
          {choices.map((item, itemIndex) => {
            const isSelected = itemIndex === index
            const isCurrent = !item.addNew && current?.provider === item.id
            const tag =
              item.oauth === 'chatgpt'
                ? ' (ChatGPT sign-in)'
                : item.keyless
                  ? ' (no key needed)'
                  : item.custom
                    ? ' (custom)'
                    : ''
            return (
              <Text key={item.id}>
                <Text bold={isSelected} color={isSelected ? activeTheme.accent : undefined}>
                  {isSelected ? '❯ ' : '  '}
                  {item.name}
                </Text>
                {tag ? (
                  <Text color={isSelected ? activeTheme.accent : activeTheme.muted}>{tag}</Text>
                ) : null}
                {isCurrent ? <Text color={activeTheme.secondary}> · current</Text> : null}
              </Text>
            )
          })}
        </Box>
      )}

      {step === 'customName' && (
        <Box flexDirection="column">
          {notice && <Text color={activeTheme.danger}>{notice}</Text>}
          <Text>Custom provider name (for example Together AI or Local vLLM):</Text>
          <Box backgroundColor={activeTheme.surface} paddingX={2} marginTop={1}>
            <Text bold color={activeTheme.surfaceText}>
              ❯{' '}
            </Text>
            <TextInput value={customName} onChange={setCustomName} onSubmit={submitCustomName} />
          </Box>
          <Box marginTop={1}>
            <Text color={activeTheme.muted}>Enter continue · Esc back</Text>
          </Box>
        </Box>
      )}

      {step === 'customUrl' && (
        <Box flexDirection="column">
          {notice && <Text color={activeTheme.danger}>{notice}</Text>}
          <Text>Endpoint base URL for {activeName} (for example https://api.together.xyz/v1):</Text>
          <Box backgroundColor={activeTheme.surface} paddingX={2} marginTop={1}>
            <Text bold color={activeTheme.surfaceText}>
              ❯{' '}
            </Text>
            <TextInput value={customUrl} onChange={setCustomUrl} onSubmit={submitCustomUrl} />
          </Box>
          <Box marginTop={1}>
            <Text color={activeTheme.muted}>Enter continue · Esc back</Text>
          </Box>
        </Box>
      )}

      {step === 'customWire' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold>API format for {activeName}</Text>
            <Text color={activeTheme.muted}> · ↑/↓ move · Enter select · Esc back</Text>
          </Box>
          {WIRE_CHOICES.map((wire, wireIndex) => {
            const isSelected = wireIndex === customWireIndex
            return (
              <Text key={wire.id}>
                <Text bold={isSelected} color={isSelected ? activeTheme.accent : undefined}>
                  {isSelected ? '❯ ' : '  '}
                  {wire.label}
                </Text>
                <Text color={isSelected ? activeTheme.accent : activeTheme.muted}>{` (${wire.hint})`}</Text>
              </Text>
            )
          })}
        </Box>
      )}

      {step === 'key' && (
        <Box flexDirection="column">
          <Text>
            {preset.addNew
              ? `Paste your ${activeName} API key (or press Enter if no key is needed):`
              : `Paste your ${preset.name} API key${preset.keyURL ? ` (from ${preset.keyURL})` : ''}:`}
          </Text>
          <Box backgroundColor={activeTheme.surface} paddingX={2} marginTop={1}>
            <Text bold color={activeTheme.surfaceText}>
              ❯{' '}
            </Text>
            <TextInput value={apiKey} onChange={setApiKey} mask="*" onSubmit={submitKey} />
          </Box>
        </Box>
      )}

      {step === 'login' && (
        <Box flexDirection="column">
          <Text>Sign in to ChatGPT to use the Codex subscription:</Text>
          {loginUrl ? (
            <Text color={activeTheme.accent}>{loginUrl}</Text>
          ) : (
            <Text color={activeTheme.muted}>Opening the sign-in page…</Text>
          )}
          <Text color={activeTheme.muted}>
            <Spinner type="dots" /> Waiting for the browser… Esc to cancel.
          </Text>
        </Box>
      )}

      {step === 'loading' && (
        <Text color={activeTheme.accent}>
          <Spinner type="dots" /> Fetching models from {activeName}…
        </Text>
      )}

      {step === 'models' && (
        <Box flexDirection="column">
          <Box>
            <Text bold>Choose a model</Text>
            <Text color={activeTheme.muted}> · ↑/↓ move · type to filter · Enter select</Text>
          </Box>
          <Box backgroundColor={activeTheme.surface} paddingX={2} marginY={1}>
            <Text bold color={activeTheme.surfaceText}>
              ❯ filter:{' '}
            </Text>
            <TextInput
              value={filter}
              onChange={(value) => {
                setFilter(value)
                setSelected(0)
              }}
              onSubmit={() => {
                const picked = filtered[safeSelected]
                if (picked) finish(picked.id)
              }}
              placeholder="(all models)"
            />
          </Box>
          {renderModelList(filtered, safeSelected, activeTheme, current?.model)}
          <Box marginTop={1}>
            <Text color={activeTheme.muted}>{filtered.length} model(s)</Text>
          </Box>
        </Box>
      )}

      {step === 'manual' && (
        <Box flexDirection="column">
          {notice && <Text color={activeTheme.warning}>{notice}</Text>}
          <Text>Model id (edit or press Enter to accept the default):</Text>
          <Box backgroundColor={activeTheme.surface} paddingX={2} marginTop={1}>
            <Text bold color={activeTheme.surfaceText}>
              ❯{' '}
            </Text>
            <TextInput value={manualModel} onChange={setManualModel} onSubmit={finish} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

function renderModelList(
  filtered: ModelInfo[],
  selected: number,
  activeTheme: TuiTheme,
  currentModel?: string,
): ReactNode {
  if (filtered.length === 0) return <Text color={activeTheme.muted}>No models match the filter.</Text>

  const start = Math.max(
    0,
    Math.min(selected - Math.floor(VISIBLE_ROWS / 2), filtered.length - VISIBLE_ROWS),
  )
  const window = filtered.slice(start, start + VISIBLE_ROWS)

  return (
    <Box flexDirection="column">
      {window.map((model, offset) => {
        const absolute = start + offset
        const isSelected = absolute === selected
        const isCurrent = currentModel === model.id
        const note = modelNote(model)
        return (
          <Text key={model.id}>
            <Text bold={isSelected} color={isSelected ? activeTheme.accent : undefined}>
              {isSelected ? '❯ ' : '  '}
              {model.id}
            </Text>
            {note ? (
              <Text color={isSelected ? activeTheme.accent : activeTheme.muted}>{` — ${note}`}</Text>
            ) : null}
            {isCurrent ? <Text color={activeTheme.secondary}> · current</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}
