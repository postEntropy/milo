import { spawn } from 'node:child_process'
import { useEffect, useState, type ReactNode } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'
import { errorMessage } from '../../../util/errors.js'
import { readAuth, readConfig, resolveApiKey, saveAuth, saveConfig } from '../../../core/config/load.js'
import { PRESETS, type Preset } from '../../../core/config/presets.js'
import { ConfigSchema, type Config, type ProviderEntry } from '../../../core/config/schema.js'
import { beginChatGptBrowserLogin, type ChatGptLogin } from '../../../core/chatgpt/auth.js'
import { chatGptModels } from '../../../core/chatgpt/models.js'
import { listModels, type ModelInfo } from '../../../core/providers/models.js'
import { modelNote } from '../../model-label.js'
import { MiloMark } from '../components/milo-mark.js'
import { isCtrlC } from '../keys.js'
import { theme as defaultTheme, type TuiTheme } from '../theme.js'

type Step = 'provider' | 'key' | 'login' | 'loading' | 'models' | 'manual'

const VISIBLE_ROWS = 12

export interface ModelPickerProps {
  current?: { provider: string; model: string }
  theme?: TuiTheme
  onDone: (config: Config) => void
  onCancel?: () => void
}

export function ModelPicker({ current, theme: activeTheme = defaultTheme, onDone, onCancel }: ModelPickerProps) {
  const [step, setStep] = useState<Step>('provider')
  const [index, setIndex] = useState(() => {
    const found = PRESETS.findIndex((preset) => preset.id === current?.provider)
    return found >= 0 ? found : 0
  })
  const [apiKey, setApiKey] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)

  const preset: Preset = PRESETS[index] ?? PRESETS[0]!
  const apiKeyValue = preset.keyless ? false : apiKey.trim() || undefined

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
                baseURL: preset.baseURL,
                wire: preset.wire,
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
  }, [step, preset.baseURL, preset.wire, preset.oauth, preset.models[0], apiKeyValue, current?.model])

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
      if (key.upArrow) setIndex((value) => (value - 1 + PRESETS.length) % PRESETS.length)
      else if (key.downArrow) setIndex((value) => (value + 1) % PRESETS.length)
      else if (key.return) {
        const signedIn = preset.oauth === 'chatgpt' ? Boolean(readAuth().chatgpt) : false
        const hasKey = Boolean(resolveApiKey(preset.id, presetEntry(), readAuth()))
        if (preset.oauth === 'chatgpt' && !signedIn) setStep('login')
        else setStep(preset.keyless || hasKey || signedIn ? 'loading' : 'key')
      } else if (key.escape) onCancel?.()
      return
    }
    if (step === 'models') {
      if (key.upArrow) setSelected((value) => Math.max(0, value - 1))
      else if (key.downArrow) setSelected((value) => Math.min(filtered.length - 1, value + 1))
      else if (key.escape) onCancel?.()
      return
    }
    if ((step === 'key' || step === 'manual' || step === 'login') && key.escape) onCancel?.()
  })

  const finish = (chosen: string) => {
    const model = chosen.trim() || preset.models[0] || 'default'
    const existing = readConfig()

    if (!preset.keyless && apiKey.trim()) {
      const auth = readAuth()
      auth.providers[preset.id] = apiKey.trim()
      saveAuth(auth)
    }

    // Built from what is on disk, not from the defaults: a file that already
    // exists may hold settings this screen has never heard of, and an object
    // assembled from scratch would drop them — and take every comment with them,
    // which is the whole reason the config is YAML. `ConfigSchema.parse` is what
    // supplies the defaults on a first run, when there is nothing on disk yet.
    const config: Config = ConfigSchema.parse({
      ...(existing ?? {}),
      provider: preset.id,
      model,
      providers: { ...(existing?.providers ?? {}), [preset.id]: presetEntry() },
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
          {PRESETS.map((item, itemIndex) => {
            const isSelected = itemIndex === index
            const isCurrent = current?.provider === item.id
            const tag =
              item.oauth === 'chatgpt'
                ? ' (ChatGPT sign-in)'
                : item.keyless
                  ? ' (no key needed)'
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

      {step === 'key' && (
        <Box flexDirection="column">
          <Text>
            Paste your {preset.name} API key{preset.keyURL ? ` (from ${preset.keyURL})` : ''}:
          </Text>
          <Box backgroundColor={activeTheme.surface} paddingX={2} marginTop={1}>
            <Text bold color={activeTheme.surfaceText}>
              ❯{' '}
            </Text>
            <TextInput value={apiKey} onChange={setApiKey} mask="*" onSubmit={() => setStep('loading')} />
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
          <Spinner type="dots" /> Fetching models from {preset.name}…
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

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', url]] as const)
        : (['xdg-open', [url]] as const)
  try {
    const child = spawn(command[0], [...command[1]], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is on screen; opening the browser is a convenience.
  }
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
