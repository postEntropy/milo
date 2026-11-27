import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api.js'
import { message, splitNames } from '../lib/format.js'
import { formatWhen } from '../../../src/core/time.js'
import { CLASSIFIER_LABELS, PERMISSION_LABELS, SEARCH_LABELS, skillOriginLabel } from '../lib/labels.js'
import type { ModelInfo } from '../../../src/core/providers/models.js'
import type { SessionBackendSummary } from '../../../src/core/sessions/types.js'
import { humanSize } from '../../../src/util/format.ts'
import { Icon } from '../ui/Icons.js'
import { Notice, useAutoDismiss } from '../ui/Notice.js'
import { Select } from '../ui/Select.js'
import { ReasoningSlider } from '../ui/ReasoningSlider.js'
import { ModelPicker } from '../ui/ModelPicker.js'
import { ProviderMark } from '../ui/ProviderMark.js'
import { usePhone } from '../lib/phone.js'
import { settingsSectionGroups, settingsSections } from './sections.js'
import { MobileModelSheet } from './MobileModelPicker.js'
import { DisplayPreview } from './DisplayPreview.js'
import { Disclosure, Segmented, SettingRow, SettingsGroup, SettingStack, Switch } from './Controls.js'
import { MiloMark } from '../ui/MiloMark.js'
import {
  COLOR_PALETTES,
  DEFAULT_COLOR_PALETTE,
  type ColorPaletteId,
  type PaletteState,
} from '../theme/palettes.js'
import { CLASSIFIER_BACKENDS, PERMISSION_MODES, SEARCH_PROVIDERS, THINKING_LEVELS, TOOL_LEVELS, type ThinkingDisplay } from '@protocol'
import { GOOGLE_SHORTCUT, GOOGLE_STEPS } from '../../../src/core/google/walkthrough.ts'
import { chatGptPlanName } from '../../../src/core/chatgpt/plan.ts'
import { computerSetupHelp, type ComputerStatusWithHelp } from '../../../src/core/computer/setup-help.ts'

type ProviderWire = 'openai' | 'anthropic' | 'responses' | 'auto'
type ProviderFormState = {
  editingId?: string
  name: string
  baseURL: string
  wire: ProviderWire
  keyless: boolean
  apiKey: string
}
const WIRE_LABELS: Record<ProviderWire, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  responses: 'Responses',
  auto: 'Auto',
}
const WIRE_CHOICES: ReadonlyArray<{ value: ProviderWire; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'responses', label: 'Responses' },
  { value: 'auto', label: 'Auto' },
]

type ProviderPreset = { id: string; name: string; baseURL: string; wire: string; keyless?: boolean; oauth?: 'chatgpt'; models: string[]; keyURL?: string }
type ChatGptStatus = { signedIn: boolean; email?: string; planType?: string; planName?: string; expiresAt?: number; codexLogin?: boolean }
type SettingsConfig = {
  provider: string
  model: string
  providers: Record<string, { name?: string; baseURL: string; wire?: string; keyless?: boolean; keyEnv?: string; oauth?: 'chatgpt'; headers?: Record<string, string> }>
  memory: { keepSaid?: number; recallLimit?: number; derive?: boolean; embedding?: { provider: 'ollama' | 'openrouter'; model?: string; url?: string } }
  sessions: { compactAt: number; contextWindow?: number; maxInputTokens: number; keepTurns: number; compaction: boolean; maxSessions: number; generateTitles: boolean; titleModel?: string }
  display: { tools: 'full' | 'name' | 'off'; thinking: ThinkingDisplay; genui?: boolean }
  palette?: PaletteState
  gateways: Record<string, { enabled: boolean; allowlist: string[] }>
  web: { enabled: boolean; host: string; port: number }
  google: { enabled: boolean }
  media?: { vision?: string; audio?: string; document?: string }
  permissions: { mode: 'ask' | 'auto' | 'yolo'; allow: string[]; deny: string[]; jevThreshold: number; jevTimeoutMs: number }
  classifier: { backend: 'commandcode' | 'openai' | 'openrouter' | 'ollaya' | 'custom'; model?: string; url?: string; keyEnv?: string; timeoutMs?: number }
  browser: { enabled: boolean; chromePath: string | null; headless: boolean; profileDir: string | null; cdpUrl: string | null; keepSnapshots: number }
  computer: { enabled: boolean }
  search?: { provider: 'tavily' | 'exa' | 'parallel'; keyEnv?: string }
  systemPrompt?: string
  maxSteps?: number
  maxTokens?: number
  reasoningEffort: 'low' | 'medium' | 'high'
}
type Skill = { name: string; description: string; origin?: string; installedAt?: string }
type MemoryStats = { backend: string; location: string; scopes: number; facts: number; bytes: number }
type Note = { id: string; text: string; createdAt: number; source?: { session: string; quote: string } }
type Browser = { id: string; name: string; path: string; version: string | null }
type Profile = { id: string; name: string; dir: string; bytes: number }
type ComputerStatus = Omit<ComputerStatusWithHelp, 'setupHelp'> & {
  setupHelp?: ComputerStatusWithHelp['setupHelp']
}
type GoogleTier = { id: 'none' | 'modify' | 'compose' | 'send'; label: string; description: string }
type GoogleReport = (
  | { kind: 'off' }
  | { kind: 'wanted' }
  | { kind: 'connected'; email?: string; connectedAt?: string; enabled: boolean; access: GoogleTier['id'] }
) & { tools: string[]; writeTools: string[]; tiers: GoogleTier[] }

function tierOf(tiers: GoogleTier[], id: GoogleTier['id']): GoogleTier | undefined {
  return tiers.find((tier) => tier.id === id)
}

function restartReasonsFor(keys: ReadonlyArray<keyof SettingsConfig>, draft: SettingsConfig, saved: SettingsConfig): string[] {
  const reasons: string[] = []
  if (keys.includes('browser') && JSON.stringify(draft.browser) !== JSON.stringify(saved.browser)) reasons.push('Browser')
  if (keys.includes('computer') && JSON.stringify(draft.computer) !== JSON.stringify(saved.computer)) reasons.push('Computer Use')
  if (keys.includes('web') && JSON.stringify(draft.web) !== JSON.stringify(saved.web)) reasons.push('Web host and port')
  if (keys.includes('classifier') && JSON.stringify(draft.classifier) !== JSON.stringify(saved.classifier)) reasons.push('Reviewer model')
  if (keys.includes('google') && JSON.stringify(draft.google) !== JSON.stringify(saved.google)) reasons.push('Google tools')
  return reasons
}

const SECTION_KEYS: Record<string, ReadonlyArray<keyof SettingsConfig>> = {
  provider: ['provider', 'model', 'providers', 'media', 'reasoningEffort', 'maxTokens'],
  memory: ['memory'],
  gateways: ['gateways'],
  web: ['web'],
  tools: ['search', 'google', 'browser', 'computer'],
  permissions: ['permissions', 'classifier'],
  display: ['display'],
  sessions: ['sessions'],
}

function changedKeys(draft: SettingsConfig, saved: SettingsConfig, keys: ReadonlyArray<keyof SettingsConfig>): Array<keyof SettingsConfig> {
  return keys.filter((key) => JSON.stringify(draft[key]) !== JSON.stringify(saved[key]))
}

function withKeys(target: SettingsConfig, source: SettingsConfig, keys: ReadonlyArray<keyof SettingsConfig>): SettingsConfig {
  const next = structuredClone(target) as unknown as Record<string, unknown>
  for (const key of keys) {
    if (source[key] === undefined) delete next[key]
    else next[key] = structuredClone(source[key])
  }
  return next as unknown as SettingsConfig
}

type SettingsData = {
  config: SettingsConfig
  auth: Record<string, Record<string, { set: boolean; masked?: string }>>
  presets: ProviderPreset[]
  chatgpt?: ChatGptStatus
  skills: Skill[]
  sessions: Array<{ id: string; title?: string; preview: string; updatedAt: number; messageCount: number; backend?: SessionBackendSummary }>
  memoryStats: MemoryStats
  mcp: McpReport
  live: { model: string; effort: string; permissionMode: string; skills: Skill[]; browser: boolean; computer?: boolean }
  computer?: ComputerStatus
  google: GoogleReport
}
type JobView = { id: string; kind: string; status: 'running' | 'done' | 'error'; lines: string[]; result?: Record<string, unknown>; error?: string }
type McpServer = {
  name: string
  command: string
  enabled: boolean
  state: 'idle' | 'connecting' | 'ready' | 'failed'
  tools: number
  readOnly: string[]
  listingAt?: number
  era?: 'modern' | 'legacy'
  error?: string
}
type McpReport = { file: string; error?: string; servers: McpServer[] }

function describeMcpServer(server: McpServer): string {
  if (!server.enabled) return 'Off — tools excluded from catalog.'
  const tools = `${server.tools} tool${server.tools === 1 ? '' : 's'}`
  const listed = server.listingAt ? ` · listed ${formatWhen(server.listingAt)}` : ''
  if (server.state === 'ready') return `Connected · ${tools}`
  if (server.state === 'connecting') return `Connecting… · ${tools} so far`
  if (server.state === 'failed') return `Not running · ${tools} from last listing`
  return server.listingAt ? `${tools}${listed}` : 'Not connected yet — run Check to connect.'
}

const TOOL_DETAIL_LABELS: Record<(typeof TOOL_LEVELS)[number], string> = { full: 'Full', name: 'Name', off: 'Hidden' }
const REASONING_LABELS: Record<(typeof THINKING_LEVELS)[number], string> = { expanded: 'Expanded', collapsed: 'Collapsed' }
const PERMISSION_DESCRIPTIONS: Record<'ask' | 'auto' | 'yolo', string> = {
  ask: 'Confirms every tool call that can cause an effect.',
  auto: 'A reviewing model approves safe calls and asks for risky ones.',
  yolo: 'Runs every tool without asking.',
}

function ChatGptAccount({ status, onChanged }: { status?: ChatGptStatus; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState<{ url: string; userCode?: string; device?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      void api<ChatGptStatus>('chatgpt-status')
        .then((next) => {
          if (!next.signedIn) return
          window.clearInterval(timer)
          setPending(null)
          void onChanged()
        })
        .catch(() => {})
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [pending, onChanged])

  async function start(device: boolean): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const answer = await api<ChatGptStatus & { url?: string; userCode?: string; device?: boolean }>('chatgpt-login', { mode: device ? 'device' : 'browser' })
      if (answer.signedIn) {
        setPending(null)
        await onChanged()
        return
      }
      if (!answer.url) throw new Error('The server did not return a sign-in link.')
      setPending({ url: answer.url, ...(answer.userCode ? { userCode: answer.userCode } : {}), ...(answer.device ? { device: true } : {}) })
      if (!answer.device) window.open(answer.url, '_blank', 'noopener,noreferrer')
    } catch (problem) {
      setError(message(problem))
    } finally {
      setBusy(false)
    }
  }

  async function signOut(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api('chatgpt-logout')
      setPending(null)
      await onChanged()
    } catch (problem) {
      setError(message(problem))
    } finally {
      setBusy(false)
    }
  }

  if (status?.signedIn) {
    const plan = status.planName ?? chatGptPlanName(status.planType) ?? ''
    return (
      <SettingsGroup title="ChatGPT account">
        <SettingRow
          label={status.email ?? 'Signed in'}
          description={plan ? `${plan} · Codex subscription active.` : 'Codex subscription active.'}
        >
          <button className="button settings-btn-sm" type="button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
        </SettingRow>
        {error && <div className="settings-row"><p className="settings-row-desc settings-error-text">{error}</p></div>}
      </SettingsGroup>
    )
  }

  return (
    <SettingsGroup title="ChatGPT account">
      <SettingRow
        label="Connect subscription"
        description="Uses a ChatGPT subscription instead of an API key. A local Codex login is imported first."
      >
        <div className="settings-inline-actions">
          <button className="button primary settings-btn-sm" type="button" onClick={() => void start(false)} disabled={busy}>Sign in</button>
          <button className="button settings-btn-sm" type="button" onClick={() => void start(true)} disabled={busy}>One-time code</button>
        </div>
      </SettingRow>
      {pending && (
        <div className="settings-row">
          <p className="settings-row-desc">
            {pending.userCode ? (
              <>Open <a className="settings-link" href={pending.url} target="_blank" rel="noreferrer">{pending.url}</a> and enter <strong>{pending.userCode}</strong>. </>
            ) : (
              <>Finish signing in in the tab that opened, or <a className="settings-link" href={pending.url} target="_blank" rel="noreferrer">open it again</a>. </>
            )}
            Waiting for sign-in…
          </p>
        </div>
      )}
      {error && <div className="settings-row"><p className="settings-row-desc settings-error-text">{error}</p></div>}
    </SettingsGroup>
  )
}

export function Settings({ section, onSection, chatId, sessionId, onClose, onSessionChange, onOpenSession, onStartSession, theme, onThemeChange, palette = DEFAULT_COLOR_PALETTE, paletteSync = false, onPaletteChange, onPaletteSyncChange, onPaletteStateLoaded, onDirtyChange }: {
  section: string | null
  onSection(section: string | null): void
  chatId: string
  sessionId: string
  onClose(): void
  onSessionChange(id: string): void
  onOpenSession(id: string): void
  onStartSession?(firstMessage: string): Promise<{ ok: true } | { ok: false; error?: string }>
  theme: string
  onThemeChange(theme: string): void
  palette?: ColorPaletteId
  paletteSync?: boolean
  onPaletteChange?(palette: ColorPaletteId): Promise<void> | void
  onPaletteSyncChange?(sync: boolean): Promise<void> | void
  onPaletteStateLoaded?(state: PaletteState): void
  onDirtyChange?(dirty: boolean): void
}) {
  const [data, setData] = useState<SettingsData | null>(null)
  const [draft, setDraft] = useState<SettingsConfig | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [skillSource, setSkillSource] = useState('')
  const [skillChoice, setSkillChoice] = useState<string[] | null>(null)
  const [popular, setPopular] = useState<Array<{ name: string; repo: string; installs?: number; description?: string }>>([])
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState(false)
  const [paletteSaving, setPaletteSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)
  const [catalog, setCatalog] = useState<ModelInfo[] | null>(null)
  const [browsing, setBrowsing] = useState<string | null>(null)
  const [editingSecret, setEditingSecret] = useState<string | null>(null)
  const noteRequest = useRef(0)
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [noteQuery, setNoteQuery] = useState('')
  const [noteOffset, setNoteOffset] = useState(0)
  const [notesMore, setNotesMore] = useState(false)
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const [noteText, setNoteText] = useState('')
  const [mcp, setMcp] = useState<McpReport | null>(null)
  const [browsers, setBrowsers] = useState<Browser[] | null>(null)
  const [profiles, setProfiles] = useState<Profile[] | null>(null)
  const [modelSheetOpen, setModelSheetOpen] = useState(false)
  const [startingHelp, setStartingHelp] = useState(false)
  const [providerForm, setProviderForm] = useState<ProviderFormState | null>(null)
  const [providerSaving, setProviderSaving] = useState(false)
  const phone = usePhone()
  const current = section ?? (phone ? null : 'provider')

  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await api<SettingsData>('overview')
      setData(result)
      setDraft(structuredClone(result.config))
      if (result.config.palette) onPaletteStateLoaded?.(result.config.palette)
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }, [onPaletteStateLoaded])

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api<SettingsData>('overview')
      setData(result)
      setDraft(structuredClone(result.config))
      if (result.config.palette) onPaletteStateLoaded?.(result.config.palette)
      setNotice(null)
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setBusy(false) }
  }, [onPaletteStateLoaded])

  useEffect(() => { void load() }, [load])

  const selectPalette = useCallback(async (next: ColorPaletteId): Promise<void> => {
    if (!onPaletteChange) return
    setPaletteSaving(true)
    try {
      await onPaletteChange(next)
      if (paletteSync) {
        const nextState: PaletteState = { sync: true, palette: next }
        setData((cur) => cur ? { ...cur, config: { ...cur.config, palette: nextState } } : cur)
        setDraft((cur) => cur ? { ...cur, palette: nextState } : cur)
      }
      setNotice(null)
    } catch (error) {
      setNotice({ text: message(error), error: true })
    } finally {
      setPaletteSaving(false)
    }
  }, [onPaletteChange, paletteSync])

  const togglePaletteSync = useCallback(async (nextSync: boolean): Promise<void> => {
    if (!onPaletteSyncChange) return
    setPaletteSaving(true)
    try {
      await onPaletteSyncChange(nextSync)
      setData((cur) => cur ? { ...cur, config: { ...cur.config, palette: { sync: nextSync, palette: nextSync ? palette : (cur.config.palette?.palette ?? DEFAULT_COLOR_PALETTE) } } } : cur)
      setDraft((cur) => cur ? { ...cur, palette: { sync: nextSync, palette: nextSync ? palette : (cur.palette?.palette ?? DEFAULT_COLOR_PALETTE) } } : cur)
      setNotice(null)
    } catch (error) {
      setNotice({ text: message(error), error: true })
    } finally {
      setPaletteSaving(false)
    }
  }, [onPaletteSyncChange, palette])

  const job = useJob(() => { void reload() })

  const refreshNotes = useCallback(async (): Promise<void> => {
    const request = ++noteRequest.current
    try { const page = await api<{ notes: Note[]; hasMore: boolean }>('memory-notes', { query: noteQuery, offset: noteOffset }); if (request === noteRequest.current) { setNotes(page.notes); setNotesMore(page.hasMore) } }
    catch (error) { if (request === noteRequest.current) setNotice({ text: message(error), error: true }) }
  }, [noteQuery, noteOffset])

  useEffect(() => { if (current === 'memory') void refreshNotes() }, [current, refreshNotes])
  useEffect(() => { if (data) setMcp(data.mcp) }, [data])

  const reloadMcp = useCallback(async (): Promise<void> => {
    try {
      setMcp(await api<McpReport>('mcp-reload'))
      setNotice({ text: 'mcp.json read again.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }, [])

  const toggleMcpServer = useCallback(async (name: string, enabled: boolean): Promise<void> => {
    try {
      setMcp(await api<McpReport>('mcp-toggle', { name, enabled }))
      setNotice({ text: `${enabled ? 'Enabled' : 'Disabled'} ${name}.`, error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }, [])

  const currentProvider = draft?.provider ?? ''
  const browsedProvider = browsing ?? currentProvider
  const presetIds = new Set(data?.presets.map((item) => item.id) ?? [])
  const customProviders = draft
    ? Object.entries(draft.providers)
        .filter(([id]) => !presetIds.has(id) && id !== 'groq')
        .map(([id, entry]) => ({
          id,
          name: entry.name ?? id,
          baseURL: entry.baseURL,
          wire: (entry.wire ?? 'openai') as ProviderWire,
          keyless: entry.keyless,
          models: [] as string[],
        }))
    : []
  const allProviders = [...(data?.presets ?? []), ...customProviders]

  const refreshChatGpt = useCallback(async (): Promise<void> => {
    try {
      const status = await api<ChatGptStatus>('chatgpt-status')
      setData((current) => current ? { ...current, chatgpt: status } : current)
      if (status.signedIn && browsedProvider) {
        setCatalog(null)
        setCatalog(await api<ModelInfo[]>('models', { provider: browsedProvider }).catch(() => []))
      }
    } catch { /* the sign-in panel keeps its last answer */ }
  }, [browsedProvider])

  useEffect(() => {
    if (current !== 'provider' || !browsedProvider) return
    let live = true
    setCatalog(null)
    void api<ModelInfo[]>('models', { provider: browsedProvider })
      .then((list) => { if (live) setCatalog(list) })
      .catch(() => { if (live) setCatalog([]) })
    return () => { live = false }
  }, [current, browsedProvider])

  const saved = data?.config
  const restartReasons: string[] = !draft || !saved ? [] : [
    ...(JSON.stringify(draft.browser) !== JSON.stringify(saved.browser) ? ['Browser'] : []),
    ...(JSON.stringify(draft.computer) !== JSON.stringify(saved.computer) ? ['Computer Use'] : []),
    ...(JSON.stringify(draft.web) !== JSON.stringify(saved.web) ? ['Web host and port'] : []),
    ...(JSON.stringify(draft.classifier) !== JSON.stringify(saved.classifier) ? ['Reviewer model'] : []),
    ...(JSON.stringify(draft.google) !== JSON.stringify(saved.google) ? ['Google tools'] : []),
  ]
  const requiresRestart = restartReasons.length > 0

  const isSectionDirty = useCallback((id: string | null): boolean => {
    if (!id || !saved || !draft) return false
    if (id === 'keys') return Object.keys(secrets).length > 0
    const keys = SECTION_KEYS[id]
    if (!keys) return false
    return changedKeys(draft, saved, keys).length > 0
  }, [draft, saved, secrets])

  const sectionDirty = isSectionDirty(current)
  const anyDirty = settingsSections.some(([id]) => isSectionDirty(id))

  useEffect(() => { onDirtyChange?.(anyDirty) }, [anyDirty, onDirtyChange])

  function discardCurrent(): void {
    if (!saved || !current) return
    if (current === 'keys') {
      setSecrets({})
      setEditingSecret(null)
      return
    }
    const keys = SECTION_KEYS[current]
    if (!keys) return
    setDraft((cur) => cur ? withKeys(cur, saved, keys) : cur)
    if (current === 'provider') setBrowsing(null)
  }

  async function saveCurrent(): Promise<void> {
    if (!draft || !saved || !current) return
    setSaving(true)
    try {
      if (current === 'keys') {
        for (const [slot, value] of Object.entries(secrets)) {
          const [group, id] = slot.split(':')
          await api('save-secret', { group, id, value })
        }
        setSecrets({})
        setEditingSecret(null)
        await load()
        setNotice({ text: 'API keys saved.', error: false })
      } else {
        const keys = SECTION_KEYS[current]
        if (!keys) return
        const toSave = withKeys(saved, draft, keys)
        await api('save-config', { config: toSave })
        const reasons = restartReasonsFor(keys, draft, saved)
        await load()
        setNotice({
          text: reasons.length > 0
            ? `Settings saved. Restart the web server to apply: ${reasons.join(', ')}.`
            : 'Settings saved.',
          error: false,
        })
      }
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setSaving(false) }
  }

  async function saveCustomProviderForm(): Promise<void> {
    if (!providerForm) return
    setProviderSaving(true)
    try {
      const saved = await api<{ id: string; created: boolean }>('save-provider', {
        ...(providerForm.editingId ? { id: providerForm.editingId } : {}),
        name: providerForm.name,
        baseURL: providerForm.baseURL,
        wire: providerForm.wire,
        keyless: providerForm.keyless,
        ...(providerForm.keyless || !providerForm.apiKey.trim() ? {} : { apiKey: providerForm.apiKey }),
      })
      setProviderForm(null)
      await reload()
      setBrowsing(saved.id)
      setNotice({ text: saved.created ? 'Custom provider added.' : 'Custom provider updated.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setProviderSaving(false) }
  }

  async function removeCustomProviderEntry(id: string, label: string): Promise<void> {
    if (!window.confirm(`Remove custom provider “${label}”?`)) return
    setProviderSaving(true)
    try {
      await api('remove-provider', { id })
      if (providerForm?.editingId === id) setProviderForm(null)
      if (browsing === id) setBrowsing(null)
      await reload()
      setNotice({ text: 'Custom provider removed.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setProviderSaving(false) }
  }

  function openAddProvider(): void {
    setProviderForm({ name: '', baseURL: '', wire: 'openai', keyless: false, apiKey: '' })
  }

  function openEditProvider(id: string): void {
    const entry = draft?.providers?.[id]
    if (!entry) return
    setProviderForm({
      editingId: id,
      name: entry.name ?? id,
      baseURL: entry.baseURL,
      wire: (entry.wire as ProviderWire) ?? 'openai',
      keyless: Boolean(entry.keyless),
      apiKey: '',
    })
  }

  function switchProvider(next: string): void {
    const item = data?.presets.find((entry) => entry.id === next)
    setBrowsing(null)
    update(['provider'], next)
    if (item) {
      update(['providers', item.id], {
        name: item.name,
        baseURL: item.baseURL,
        wire: item.wire,
        ...(item.oauth
          ? { oauth: item.oauth }
          : item.keyless
            ? { keyless: true }
            : { keyEnv: `${item.id.toUpperCase()}_API_KEY` }),
      })
      if (item.models[0]) update(['model'], item.models[0])
    }
  }

  function pickModel(next: string): void {
    if (browsing && browsing !== currentProvider) switchProvider(browsing)
    update(['model'], next)
  }

  function update(path: string[], value: unknown): void {
    setDraft((current) => {
      if (!current) return current
      const next = structuredClone(current)
      let target: Record<string, unknown> = next
      for (const key of path.slice(0, -1)) {
        const child = target[key]
        if (!child || typeof child !== 'object' || Array.isArray(child)) return current
        target = child as Record<string, unknown>
      }
      target[path[path.length - 1]] = value
      return next
    })
  }

  async function saveNow(patch: (config: SettingsConfig) => void, note: string): Promise<void> {
    if (!draft) return
    setSaving(true)
    try {
      const next = structuredClone(draft)
      patch(next)
      await api('save-config', { config: next })
      await reload()
      setNotice({ text: note, error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setSaving(false) }
  }

  async function refreshPopular(): Promise<void> {
    try { setPopular(await api('popular-skills')) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function install(source: string, skill?: string): Promise<void> {
    if (!skill && !window.confirm(`Install skill instructions from this source?\n\n${source}\n\nRead the skill before trusting it.`)) return
    try {
      const result = await api<{ needChoice?: string[] }>('install-skill', { source, skill })
      if (result.needChoice) {
        setSkillChoice(result.needChoice)
        setNotice({ text: 'That source holds several skills — pick one.', error: false })
        return
      }
      setSkillChoice(null)
      setSkillSource('')
      await load()
      setNotice({ text: 'Skill installed. Restart Milo to index it in the session.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function remove(name: string): Promise<void> {
    if (!window.confirm(`Remove the skill “${name}”?`)) return
    try { await api('remove-skill', { name }); await load(); setNotice({ text: 'Skill removed.', error: false }) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function forgetNote(id: string): Promise<void> {
    try { await api('forget-note', { id }); await refreshNotes() }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function saveNote(id: string): Promise<void> {
    try { await api('update-note', { id, text: noteText }); setEditingNote(null); await refreshNotes() }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function startJob(kind: string, body: Record<string, unknown> = {}): Promise<void> {
    job.clear()
    try { await job.run(kind, body) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function exportSession(id: string): Promise<void> {
    try {
      const result = await api<{ path: string } | null>('export', { id, format: 'md' })
      setNotice(result ? { text: `Exported to ${result.path}`, error: false } : { text: 'Nothing to export — this session has no log.', error: true })
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function deleteSession(id: string): Promise<void> {
    if (!window.confirm('Delete this session permanently? The history log keeps its record, but it disappears from the session list.')) return
    try { await api('session-delete', { id, current: sessionId }); await load(); setNotice({ text: 'Session deleted.', error: false }) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  const notices = <>
    <Notice notice={notice} onDismiss={() => setNotice(null)} />
    {job.job && <JobLog job={job.job} onClose={() => job.clear()} />}
    {requiresRestart && <p className="notice restart-notice" role="status">Restart the web server to apply: {restartReasons.join(', ')}.</p>}
  </>

  const embeddingMode = draft?.memory.embedding?.provider ?? 'off'

  return <div className="settings-workspace">
    {busy && <div className="settings-inner"><p className="settings-loading" role="status">Reading Milo’s settings…</p></div>}
    {!busy && !data && <div className="settings-inner"><div className="notice error">{notice?.text ?? 'Could not open settings.'} <button className="button settings-btn-sm" type="button" onClick={() => void load()}>Try again</button></div></div>}
    {data && draft && <div className="settings-layout">
      {(!phone || current === null) && <SettingsIndex
        current={current}
        isDirty={isSectionDirty}
        onSelect={onSection}
        onBack={onClose}
      >{phone && notices}</SettingsIndex>}
      {current !== null && <div className="settings-inner">
        {phone && <header className="settings-mobile-head">
          <button className="settings-strip-back" type="button" aria-label="Settings" title="Settings" onClick={() => onSection(null)}><Icon name="arrow-left" size={17} /></button>
          <h1>{settingsSections.find(([id]) => id === current)?.[2]}</h1>
        </header>}
        {!phone && notices}
        <div className="settings-panel-stack">

          {/* ── Provider & model ─────────────────────────────────────── */}
          <Section title="Provider & model" description="Choose the provider and model that answer your sessions." active={current === 'provider'}>
            {phone ? (
              <>
                <div className="mobile-model-card">
                  <div className="mobile-model-card-info">
                    <span className="mobile-model-card-label">
                      {draft.model === data.config.model && draft.provider === data.config.provider ? 'Active model' : 'Selected model (unsaved)'}
                    </span>
                    <span className="mobile-model-card-name">{draft.model}</span>
                    <span className="mobile-model-card-provider">
                      {allProviders.find((item) => item.id === draft.provider)?.name ?? draft.provider}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button settings-btn-sm"
                    onClick={() => {
                      setBrowsing(draft.provider)
                      setModelSheetOpen(true)
                    }}
                  >
                    Change
                  </button>
                </div>
                {modelSheetOpen && (
                  <MobileModelSheet
                    presets={allProviders}
                    provider={draft.provider}
                    model={draft.model}
                    browsing={browsedProvider}
                    catalog={catalog}
                    onBrowse={setBrowsing}
                    onPick={pickModel}
                    onClose={() => setModelSheetOpen(false)}
                  />
                )}
              </>
            ) : (
              <ModelPicker
                presets={allProviders}
                provider={draft.provider}
                model={draft.model}
                browsing={browsedProvider}
                catalog={catalog}
                onBrowse={setBrowsing}
                onPick={pickModel}
              />
            )}

            {(draft.provider === 'chatgpt' || browsedProvider === 'chatgpt') && (
              <ChatGptAccount status={data.chatgpt} onChanged={refreshChatGpt} />
            )}

            <SettingsGroup
              title="Custom providers"
              action={!providerForm && (
                <button className="button settings-btn-sm" type="button" onClick={openAddProvider}>
                  Add provider
                </button>
              )}
            >
              {customProviders.length === 0 && !providerForm && (
                <div className="settings-row">
                  <p className="settings-row-desc">
                    Connect any OpenAI-compatible, Anthropic, or local endpoint with its own API key.
                  </p>
                </div>
              )}
              {customProviders.map((item) => {
                const keySet = Boolean(data.auth.providers?.[item.id]?.set)
                const isActive = item.id === data.config.provider
                const statusLabel = item.keyless ? 'No key required' : keySet ? 'Key set' : 'No key'
                return (
                  <SettingRow
                    key={item.id}
                    label={
                      <span className="settings-key-identity">
                        <ProviderMark id={item.id} size={15} />
                        <span>{item.name}</span>
                      </span>
                    }
                    description={`${item.baseURL} · ${WIRE_LABELS[item.wire] ?? item.wire} · ${statusLabel}`}
                  >
                    <div className="settings-inline-actions">
                      <button
                        className="button settings-btn-sm"
                        type="button"
                        disabled={providerSaving}
                        onClick={() => openEditProvider(item.id)}
                      >
                        Edit
                      </button>
                      <button
                        className="button danger settings-btn-sm"
                        type="button"
                        disabled={providerSaving || isActive}
                        title={isActive ? 'Switch to another provider before removing this one' : undefined}
                        onClick={() => void removeCustomProviderEntry(item.id, item.name)}
                      >
                        Remove
                      </button>
                    </div>
                  </SettingRow>
                )
              })}
              {providerForm && (
                <>
                  <SettingStack label="Name" htmlFor="custom-provider-name">
                    <input
                      id="custom-provider-name"
                      className="settings-input"
                      placeholder="Together AI"
                      value={providerForm.name}
                      onChange={(event) => setProviderForm((cur) => cur ? { ...cur, name: event.target.value } : cur)}
                    />
                  </SettingStack>
                  <SettingStack label="Endpoint URL" htmlFor="custom-provider-url">
                    <input
                      id="custom-provider-url"
                      className="settings-input"
                      type="url"
                      placeholder="https://api.together.xyz/v1"
                      value={providerForm.baseURL}
                      onChange={(event) => setProviderForm((cur) => cur ? { ...cur, baseURL: event.target.value } : cur)}
                    />
                  </SettingStack>
                  <SettingRow label="API format" description="Wire protocol the endpoint speaks.">
                    <Segmented
                      label="API format"
                      value={providerForm.wire}
                      choices={WIRE_CHOICES}
                      onChange={(wire) => setProviderForm((cur) => cur ? { ...cur, wire } : cur)}
                    />
                  </SettingRow>
                  <SettingRow
                    label="No API key required"
                    description="Turn on for local servers that do not use an API key."
                  >
                    <Switch
                      label="No API key required"
                      checked={providerForm.keyless}
                      onChange={(keyless) => setProviderForm((cur) => cur ? { ...cur, keyless } : cur)}
                    />
                  </SettingRow>
                  {!providerForm.keyless && (
                    <SettingStack label="API key" htmlFor="custom-provider-key">
                      <input
                        id="custom-provider-key"
                        className="settings-input"
                        type="password"
                        autoComplete="new-password"
                        placeholder={providerForm.editingId ? 'Leave empty to keep current key' : 'Paste API key…'}
                        value={providerForm.apiKey}
                        onChange={(event) => setProviderForm((cur) => cur ? { ...cur, apiKey: event.target.value } : cur)}
                      />
                    </SettingStack>
                  )}
                  <div className="settings-row">
                    <div className="settings-inline-actions">
                      <button
                        className="button primary settings-btn-sm"
                        type="button"
                        disabled={providerSaving}
                        onClick={() => void saveCustomProviderForm()}
                      >
                        {providerSaving ? 'Saving…' : 'Save provider'}
                      </button>
                      <button
                        className="button settings-btn-sm"
                        type="button"
                        disabled={providerSaving}
                        onClick={() => setProviderForm(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </>
              )}
            </SettingsGroup>

            <SettingsGroup title="Generation">
              <SettingRow
                label="Reasoning effort"
                description="How hard the model thinks before replying."
              >
                <div className="settings-effort-wrap">
                  <ReasoningSlider value={draft.reasoningEffort} onChange={(next) => update(['reasoningEffort'], next)} />
                </div>
              </SettingRow>
            </SettingsGroup>

            <Disclosure label="Advanced" meta="Endpoints, media models & token limit">
              <SettingsGroup>
                <SettingStack label="API URL" htmlFor="provider-api-url">
                  <input
                    id="provider-api-url"
                    className="settings-input"
                    value={draft.providers?.[currentProvider]?.baseURL ?? ''}
                    onChange={(event) => update(['providers', currentProvider, 'baseURL'], event.target.value)}
                  />
                </SettingStack>
                <SettingStack
                  label="Vision model"
                  description="Override when the main provider does not report image support."
                  htmlFor="provider-vision"
                >
                  <input
                    id="provider-vision"
                    className="settings-input"
                    value={draft.media?.vision ?? ''}
                    placeholder="Use the main model"
                    onChange={(event) => update(['media', 'vision'], event.target.value || undefined)}
                  />
                </SettingStack>
                <SettingStack
                  label="Audio transcription model"
                  description="Groq Whisper. Requires a Groq key under API keys."
                  htmlFor="provider-audio"
                >
                  <input
                    id="provider-audio"
                    className="settings-input"
                    value={draft.media?.audio ?? 'whisper-large-v3-turbo'}
                    onChange={(event) => update(['media', 'audio'], event.target.value)}
                  />
                </SettingStack>
                <SettingStack label="Document model" htmlFor="provider-document">
                  <input
                    id="provider-document"
                    className="settings-input"
                    value={draft.media?.document ?? ''}
                    placeholder="Use the main model"
                    onChange={(event) => update(['media', 'document'], event.target.value || undefined)}
                  />
                </SettingStack>
                <SettingRow
                  label="Output limit (tokens)"
                  description="Maximum tokens per reply. Leave empty for the provider’s default."
                  htmlFor="provider-max-tokens"
                >
                  <input
                    id="provider-max-tokens"
                    className="settings-input settings-input-num"
                    type="number"
                    min="1"
                    placeholder="Default"
                    value={draft.maxTokens ?? ''}
                    onChange={(event) => update(['maxTokens'], event.target.value ? Number(event.target.value) : undefined)}
                  />
                </SettingRow>
              </SettingsGroup>
            </Disclosure>
          </Section>

          {/* ── API keys ─────────────────────────────────────────────── */}
          <Section title="API keys" description="Keys are stored locally and never shown in full." active={current === 'keys'}>
            <div className="settings-groups-stack">
              {(['providers', 'audio', 'search', 'gateways'] as const).map((group) => {
                const ids = group === 'providers'
                  ? [...new Set([
                      ...data.presets.filter((item) => !item.oauth && item.id !== 'chatgpt').map((item) => item.id),
                      ...Object.entries(data.config.providers).filter(([, entry]) => !entry.keyless && !entry.oauth).map(([id]) => id),
                      ...Object.keys(data.auth.providers),
                    ])].filter((id) => id !== 'groq' && id !== 'chatgpt' && !data.presets.some((item) => item.id === id && item.oauth))
                  : group === 'audio' ? ['groq']
                  : group === 'search' ? ['tavily', 'exa', 'parallel']
                  : ['telegram', 'discord']
                const label = group === 'providers' ? 'Providers' : group === 'audio' ? 'Audio' : group === 'search' ? 'Web search' : 'Gateways'
                const orderedIds = [...ids].sort((a, b) => Number(Boolean(data.auth[group]?.[b]?.set)) - Number(Boolean(data.auth[group]?.[a]?.set)))
                const configuredCount = orderedIds.filter((id) => data.auth[group]?.[id]?.set).length
                return (
                  <SettingsGroup key={group} id={`keys-${group}`} title={label} meta={`${configuredCount} of ${ids.length} set`}>
                    {orderedIds.map((id) => {
                      const configured = Boolean(data.auth[group]?.[id]?.set)
                      const slot = `${group}:${id}`
                      const editing = editingSecret === slot
                      const serviceName = group === 'providers'
                        ? data.config.providers[id]?.name ?? data.presets.find((preset) => preset.id === id)?.name ?? id
                        : id === 'exa' ? 'Exa' : id.charAt(0).toUpperCase() + id.slice(1)
                      return (
                        <div className={`settings-row settings-key-row${editing ? ' is-editing' : ''}`} key={slot}>
                          <div className="settings-key-main">
                            <div className="settings-key-identity">
                              {group === 'providers' && <ProviderMark id={id} size={16} />}
                              <span className="settings-row-label">{serviceName}</span>
                              <span className={`settings-key-status${configured ? ' is-set' : ''}`}>
                                {configured ? data.auth[group]?.[id]?.masked : 'Not set'}
                              </span>
                            </div>
                            <div className="settings-inline-actions">
                              <button
                                className="button settings-btn-sm"
                                type="button"
                                aria-expanded={editing}
                                onClick={() => {
                                  if (editing) setSecrets((cur) => { const next = { ...cur }; delete next[slot]; return next })
                                  setEditingSecret(editing ? null : slot)
                                }}
                              >
                                {editing ? 'Cancel' : configured ? 'Replace' : 'Add key'}
                              </button>
                              {configured && (
                                <button
                                  className="button danger settings-btn-sm"
                                  type="button"
                                  onClick={async () => {
                                    await api('remove-secret', { group, id })
                                    setSecrets((cur) => { const next = { ...cur }; delete next[slot]; return next })
                                    setEditingSecret(null)
                                    await load()
                                  }}
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          </div>
                          {editing && (
                            <div className="settings-key-editor">
                              <input
                                className="settings-input"
                                aria-label={`${configured ? 'Replace' : 'Add'} ${id} API key`}
                                type="password"
                                autoComplete="new-password"
                                placeholder={configured ? 'Paste new API key…' : 'Paste API key…'}
                                value={secrets[slot] ?? ''}
                                onChange={(event) => setSecrets((cur) => ({ ...cur, [slot]: event.target.value }))}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </SettingsGroup>
                )
              })}
            </div>
          </Section>

          {/* ── Appearance ───────────────────────────────────────────── */}
          <Section title="Appearance" description="Theme, colour palette, and how turns appear in the chat." active={current === 'display'}>
            <DisplayPreview tools={draft.display.tools} thinking={draft.display.thinking} />

            <SettingsGroup title="Interface">
              <SettingRow label="Theme" description="Applies to this browser only.">
                <Segmented
                  label="Theme"
                  value={theme}
                  choices={[
                    { value: 'system', label: 'System' },
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                  ]}
                  onChange={onThemeChange}
                />
              </SettingRow>
              <SettingRow label="Tool detail" description="How much of each tool call shows in the thread.">
                <Segmented
                  label="Tool detail"
                  value={draft.display.tools}
                  choices={TOOL_LEVELS.map((value) => ({ value, label: TOOL_DETAIL_LABELS[value] }))}
                  onChange={(next) => update(['display', 'tools'], next)}
                />
              </SettingRow>
              <SettingRow label="Reasoning" description="Whether thoughts start open or folded.">
                <Segmented
                  label="Reasoning"
                  value={draft.display.thinking}
                  choices={THINKING_LEVELS.map((value) => ({ value, label: REASONING_LABELS[value] }))}
                  onChange={(next) => update(['display', 'thinking'], next)}
                />
              </SettingRow>
              <SettingRow
                label="GenUI"
                badge={<span className="experimental-tag">Experimental</span>}
                description="Draw tables, plans, and forms directly inline instead of describing them in prose."
              >
                <Switch
                  label="GenUI"
                  checked={draft.display.genui === true}
                  onChange={(next) => update(['display', 'genui'], next)}
                />
              </SettingRow>
            </SettingsGroup>

            <SettingsGroup
              title="Colour palette"
              footer={paletteSync ? 'Shared between Web and iPhone.' : 'Applies to this browser while sync is off. Peach is the default.'}
            >
              <div className="settings-row settings-row-stack">
                <div className="palette-picker" role="radiogroup" aria-label="Colour palette">
                  {COLOR_PALETTES.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`palette-option ${palette === option.id ? 'active' : ''}`}
                      aria-pressed={palette === option.id}
                      disabled={paletteSaving}
                      onClick={() => void selectPalette(option.id)}
                    >
                      <MiloMark palette={option.id} size={20} />
                      <span className="palette-option-name">{option.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <SettingRow
                label="Sync across Web and iPhone"
                description={paletteSync ? 'Choosing a palette updates both surfaces.' : 'Each surface keeps its own palette.'}
              >
                <Switch
                  label="Sync palette across Web and iPhone"
                  checked={paletteSync}
                  disabled={paletteSaving}
                  onChange={(next) => void togglePaletteSync(next)}
                />
              </SettingRow>
            </SettingsGroup>
          </Section>

          {/* ── Tools ────────────────────────────────────────────────── */}
          <Section title="Tools" description="Optional capabilities Milo can use during a session." active={current === 'tools'}>
            <div className="settings-groups-stack">
              <SettingsGroup title="Web search">
                <SettingRow
                  label="Search provider"
                  description="Off removes the web search tool from Milo’s catalog."
                >
                  <div className="settings-select-wrap">
                    <Select
                      label="Web search"
                      value={draft.search?.provider ?? 'off'}
                      choices={SEARCH_PROVIDERS.map((value) => ({ value, label: SEARCH_LABELS[value] }))}
                      onChange={(next) => update(['search'], next === 'off' ? undefined : { provider: next })}
                    />
                  </div>
                </SettingRow>
              </SettingsGroup>

              <SettingsGroup
                title="Google"
                meta={data.google.kind === 'connected' ? 'Connected' : data.google.kind === 'wanted' ? 'Not authorised' : 'Not connected'}
                footer={
                  data.google.kind === 'connected'
                    ? <><code className="mono">milo google connect</code> to change access · <code className="mono">milo google forget</code> to disconnect.</>
                    : undefined
                }
              >
                <SettingRow
                  label="Gmail and Drive"
                  badge={<span className="settings-tag">Restart</span>}
                  description={
                    data.google.kind === 'connected'
                      ? `${data.google.email ?? 'Connected account'}${data.google.connectedAt ? ` · since ${data.google.connectedAt.slice(0, 10)}` : ''}`
                      : 'Read mail and Drive, or grant write tiers with your own Google Cloud OAuth app.'
                  }
                >
                  <Switch
                    label="Enable Gmail and Drive"
                    checked={draft.google.enabled}
                    onChange={(next) => update(['google', 'enabled'], next)}
                  />
                </SettingRow>
                {data.google.kind === 'connected' && (
                  <SettingRow
                    label="Access level"
                    description={tierOf(data.google.tiers, data.google.access)?.description ?? 'Read Gmail and Drive.'}
                  >
                    <span className="settings-tag settings-tag-accent">
                      {tierOf(data.google.tiers, data.google.access)?.label ?? data.google.access}
                    </span>
                  </SettingRow>
                )}
                {data.google.kind !== 'connected' && (
                  <div className="settings-row settings-row-stack">
                    <Disclosure label="Setup guide" meta="6 steps in Google Cloud">
                      <ol className="settings-steps">
                        {GOOGLE_STEPS.map((step) => (
                          <li key={step.what}>
                            {step.url ? <a className="settings-link" href={step.url} target="_blank" rel="noreferrer">{step.what}</a> : step.what}
                            {step.why ? ` — ${step.why}` : ''}
                          </li>
                        ))}
                      </ol>
                      <p className="settings-row-desc settings-steps-foot">
                        Then run <code className="mono">milo google connect</code> on this machine. The shortcut at{' '}
                        <a className="settings-link" href={GOOGLE_SHORTCUT} target="_blank" rel="noreferrer">Google’s Workspace guide</a>{' '}
                        creates the project and downloads <code className="mono">credentials.json</code> for <code className="mono">--credentials</code>.
                      </p>
                    </Disclosure>
                  </div>
                )}
              </SettingsGroup>

              <SettingsGroup
                title="Browser"
                footer="Copying a browser profile carries your sign-ins into Milo. Close that browser before copying."
              >
                <SettingRow
                  label="Enable browser"
                  badge={<span className="settings-tag">Restart</span>}
                  description="Let Milo open pages, click, and inspect web apps."
                >
                  <Switch
                    label="Enable the browser"
                    checked={draft.browser.enabled}
                    onChange={(next) => update(['browser', 'enabled'], next)}
                  />
                </SettingRow>
                <SettingRow
                  label="Headless mode"
                  description="Run without a visible browser window."
                  disabled={!draft.browser.enabled}
                >
                  <Switch
                    label="Run without a visible window"
                    checked={draft.browser.headless}
                    onChange={(next) => update(['browser', 'headless'], next)}
                  />
                </SettingRow>
                <SettingRow
                  label="Page snapshots kept"
                  description="Oldest snapshots are dropped past this limit."
                  htmlFor="browser-snapshots"
                  disabled={!draft.browser.enabled}
                >
                  <input
                    id="browser-snapshots"
                    className="settings-input settings-input-num"
                    type="number"
                    min="0"
                    value={draft.browser.keepSnapshots}
                    onChange={(event) => update(['browser', 'keepSnapshots'], Number(event.target.value))}
                  />
                </SettingRow>
                <div className="settings-row">
                  <div className="settings-inline-actions">
                    <button className="button settings-btn-sm" type="button" onClick={async () => { try { setBrowsers(await api('browsers')) } catch (error) { setNotice({ text: message(error), error: true }) } }}>Find browsers</button>
                    <button className="button settings-btn-sm" type="button" disabled={saving} onClick={() => void startJob('browser-install')}><Icon name="download" size={14} /> Download Chrome</button>
                    <button className="button settings-btn-sm" type="button" onClick={async () => { try { setProfiles(await api('profiles')) } catch (error) { setNotice({ text: message(error), error: true }) } }}>Find profiles</button>
                  </div>
                </div>
                {browsers && (browsers.length === 0
                  ? <div className="settings-row"><p className="settings-empty-inline">No browser found on this machine.</p></div>
                  : browsers.map((browser) => (
                    <SettingRow
                      key={browser.path}
                      label={`${browser.name}${browser.version ? ` · ${browser.version}` : ''}`}
                      description={<span className="mono">{browser.path}</span>}
                    >
                      <button className="button settings-btn-sm" type="button" onClick={() => { update(['browser', 'chromePath'], browser.path); setNotice({ text: 'Browser chosen — Save changes to keep it.', error: false }) }}>Use</button>
                    </SettingRow>
                  ))
                )}
                {profiles && (profiles.length === 0
                  ? <div className="settings-row"><p className="settings-empty-inline">No profile found to copy.</p></div>
                  : profiles.map((profile) => (
                    <SettingRow
                      key={profile.dir}
                      label={profile.name}
                      description={<span className="mono">{profile.dir} · {humanSize(profile.bytes)}</span>}
                    >
                      <button className="button settings-btn-sm" type="button" disabled={saving} onClick={() => void startJob('profile-copy', { id: profile.id, dir: profile.dir })}>Copy and use</button>
                    </SettingRow>
                  ))
                )}
                <div className="settings-row settings-row-stack">
                  <Disclosure label="Paths & remote debugging" meta="Binary, profile, CDP">
                    <div className="settings-subfields">
                      <div className="settings-subfield">
                        <label className="settings-row-label" htmlFor="browser-binary">Browser binary</label>
                        <input id="browser-binary" className="settings-input" value={draft.browser.chromePath ?? ''} onChange={(event) => update(['browser', 'chromePath'], event.target.value || null)} placeholder="Auto — first browser found" />
                      </div>
                      <div className="settings-subfield">
                        <label className="settings-row-label" htmlFor="browser-profile">Profile directory</label>
                        <input id="browser-profile" className="settings-input" value={draft.browser.profileDir ?? ''} onChange={(event) => update(['browser', 'profileDir'], event.target.value || null)} placeholder="Milo’s own profile" />
                      </div>
                      <div className="settings-subfield">
                        <label className="settings-row-label" htmlFor="browser-cdp">Attach to (CDP URL)</label>
                        <input id="browser-cdp" className="settings-input" value={draft.browser.cdpUrl ?? ''} onChange={(event) => update(['browser', 'cdpUrl'], event.target.value || null)} placeholder="host:port" />
                        <p className="settings-row-desc">Drive a browser already running with remote debugging.</p>
                      </div>
                    </div>
                  </Disclosure>
                </div>
              </SettingsGroup>

              <SettingsGroup title="Computer Use">
                <SettingRow
                  label="Enable Computer Use"
                  badge={<span className="settings-tag">Restart</span>}
                  description="Drive native desktop apps on this machine."
                >
                  <Switch
                    label="Enable Computer Use"
                    checked={draft.computer?.enabled ?? false}
                    onChange={(next) => update(['computer', 'enabled'], next)}
                  />
                </SettingRow>
                {data.computer && (() => {
                  const computer = data.computer
                  const setupHelp =
                    computer.setupHelp !== undefined
                      ? computer.setupHelp
                      : computerSetupHelp(computer)
                  const capabilities = [
                    computer.displayServer,
                    computer.atspiAvailable ? 'AT-SPI' : null,
                    computer.screenCaptureAvailable ? 'Capture' : null,
                  ].filter(Boolean).join(' · ')
                  return (
                    <>
                      <SettingRow
                        label={
                          <span className="settings-status-label">
                            <span className={`settings-dot${computer.available ? ' is-ok' : ' is-off'}`} />
                            {computer.available ? 'Host backend ready' : 'Host backend unavailable'}
                          </span>
                        }
                        description={
                          computer.available
                            ? capabilities || 'Ready'
                            : (computer.reason ?? 'Required host services not detected.')
                        }
                      >
                        <div className="settings-inline-actions">
                          {setupHelp && onStartSession && (
                            <button
                              className="button primary settings-btn-sm"
                              type="button"
                              disabled={startingHelp}
                              onClick={async () => {
                                setStartingHelp(true)
                                try {
                                  const outcome = await onStartSession(setupHelp.prompt)
                                  if (!outcome.ok && outcome.error) {
                                    setNotice({ text: outcome.error, error: true })
                                  }
                                } catch (error) {
                                  setNotice({ text: message(error), error: true })
                                } finally {
                                  setStartingHelp(false)
                                }
                              }}
                            >
                              {startingHelp ? 'Opening…' : setupHelp.label}
                            </button>
                          )}
                          <button
                            className="button settings-btn-sm"
                            type="button"
                            onClick={async () => {
                              try {
                                const next = await api<ComputerStatus>('computer-status')
                                setData((cur) => (cur ? { ...cur, computer: next } : cur))
                                setNotice({ text: `Computer Use status: ${next.summary}`, error: !next.available })
                              } catch (error) {
                                setNotice({ text: message(error), error: true })
                              }
                            }}
                          >
                            Check status
                          </button>
                        </div>
                      </SettingRow>
                      {(computer.limitations.length > 0 || computer.sdkVersion) && (
                        <div className="settings-row settings-row-stack">
                          <Disclosure
                            label="Diagnostics"
                            meta={
                              computer.limitations.length > 0
                                ? `${computer.limitations.length} limitation${computer.limitations.length === 1 ? '' : 's'}`
                                : computer.sdkVersion ? `SDK ${computer.sdkVersion}` : undefined
                            }
                          >
                            <div className="settings-subfields">
                              <p className="settings-row-desc">{computer.summary}</p>
                              {computer.limitations.map((limitation) => (
                                <p className="settings-row-desc" key={limitation}>{limitation}</p>
                              ))}
                            </div>
                          </Disclosure>
                        </div>
                      )}
                    </>
                  )
                })()}
              </SettingsGroup>
            </div>
          </Section>

          {/* ── MCP ──────────────────────────────────────────────────── */}
          <Section title="MCP" description="External tool servers connected over Model Context Protocol." active={current === 'mcp'}>
            <SettingsGroup
              title="Configured servers"
              meta={mcp ? `${mcp.servers.length}` : undefined}
              action={<button className="button settings-btn-sm" type="button" onClick={() => void reloadMcp()}>Reload mcp.json</button>}
              footer={<>Configured in <code className="mono">{mcp?.file ?? '~/.milo/mcp.json'}</code>. Save changes does not touch this file.</>}
            >
              {mcp?.error && (
                <div className="settings-row">
                  <p className="settings-row-desc settings-error-text">{mcp.error}</p>
                </div>
              )}
              {!mcp ? (
                <div className="settings-row"><p className="settings-empty-inline">Reading…</p></div>
              ) : mcp.servers.length === 0 ? (
                <div className="settings-row"><p className="settings-empty-inline">No external tool servers configured.</p></div>
              ) : (
                mcp.servers.map((server) => (
                  <SettingRow
                    key={server.name}
                    label={
                      <span className="settings-status-label">
                        <span className={`settings-dot${!server.enabled ? ' is-off' : server.state === 'ready' ? ' is-ok' : server.state === 'failed' ? ' is-err' : ' is-warn'}`} />
                        {server.name}
                      </span>
                    }
                    description={
                      <>
                        <code className="mono">{server.command}</code>
                        {' · '}
                        {describeMcpServer(server)}
                        {server.error ? ` · ${server.error}` : ''}
                      </>
                    }
                  >
                    <div className="settings-inline-actions">
                      <button className="button settings-btn-sm" type="button" disabled={!server.enabled} onClick={() => void startJob('mcp-check', { name: server.name })}>Check</button>
                      <button className="button settings-btn-sm" type="button" onClick={() => void toggleMcpServer(server.name, !server.enabled)}>{server.enabled ? 'Disable' : 'Enable'}</button>
                    </div>
                  </SettingRow>
                ))
              )}
            </SettingsGroup>
          </Section>

          {/* ── Skills ───────────────────────────────────────────────── */}
          <Section title="Skills" description="Instructions the model can load on demand. Install only what you trust." active={current === 'skills'}>
            <div className="settings-groups-stack">
              <SettingsGroup title="Installed" meta={`${data.skills.length}`}>
                {data.skills.length === 0 ? (
                  <div className="settings-row"><p className="settings-empty-inline">No skills installed.</p></div>
                ) : (
                  data.skills.map((skill) => (
                    <SettingRow
                      key={skill.name}
                      label={skill.name}
                      description={skill.description ? `${skillOriginLabel(skill.origin)} · ${skill.description}` : skillOriginLabel(skill.origin)}
                    >
                      <button className="button danger settings-btn-sm" type="button" onClick={() => void remove(skill.name)}>Remove</button>
                    </SettingRow>
                  ))
                )}
              </SettingsGroup>

              <SettingsGroup title="Add a skill">
                <div className="settings-row settings-row-stack">
                  <div className="settings-input-action">
                    <input
                      className="settings-input"
                      aria-label="Skill source"
                      value={skillSource}
                      onChange={(event) => { setSkillSource(event.target.value); setSkillChoice(null) }}
                      placeholder="owner/repo, URL, or local folder"
                    />
                    <button className="button primary settings-btn-sm" type="button" disabled={!skillSource.trim()} onClick={() => void install(skillSource)}>
                      <Icon name="download" size={14} /> Install
                    </button>
                    <button className="button settings-btn-sm" type="button" onClick={() => void refreshPopular()}>Browse popular</button>
                  </div>
                  {skillChoice && (
                    <div className="settings-inline-actions settings-choice-row">
                      {skillChoice.map((name) => (
                        <button className="button settings-btn-sm" type="button" key={name} onClick={() => void install(skillSource, name)}>Install {name}</button>
                      ))}
                    </div>
                  )}
                </div>
              </SettingsGroup>

              {popular.length > 0 && (
                <SettingsGroup title="Popular">
                  {popular.map((skill) => (
                    <SettingRow
                      key={`${skill.repo}-${skill.name}`}
                      label={skill.name}
                      description={skill.description ?? skill.repo}
                    >
                      <div className="settings-inline-actions">
                        {skill.installs ? <span className="row-count">{skill.installs} install{skill.installs === 1 ? '' : 's'}</span> : null}
                        <button className="button settings-btn-sm" type="button" onClick={() => void install(`${skill.repo}/${skill.name}`)}>Install</button>
                      </div>
                    </SettingRow>
                  ))}
                </SettingsGroup>
              )}
            </div>
          </Section>

          {/* ── Memory ───────────────────────────────────────────────── */}
          <Section title="Memory" description="What Milo keeps between sessions and how it recalls it." active={current === 'memory'}>
            <div className="settings-groups-stack">
              <SettingsGroup title="Automatic memory">
                <SettingRow
                  label="Save facts automatically"
                  description="Extract durable facts at the end of each turn."
                >
                  <Switch
                    label="Save facts automatically at the end of each turn"
                    checked={draft.memory.derive !== false}
                    onChange={(next) => update(['memory', 'derive'], next)}
                  />
                </SettingRow>
                <SettingRow
                  label="Recent messages kept"
                  description="Leave empty for Milo’s default."
                  htmlFor="memory-keep-said"
                >
                  <input
                    id="memory-keep-said"
                    className="settings-input settings-input-num"
                    type="number"
                    min="1"
                    placeholder="Default"
                    value={draft.memory.keepSaid ?? ''}
                    onChange={(event) => update(['memory', 'keepSaid'], event.target.value ? Number(event.target.value) : undefined)}
                  />
                </SettingRow>
                <SettingRow
                  label="Notes used per reply"
                  description="Maximum memories included in each turn."
                  htmlFor="memory-recall-limit"
                >
                  <input
                    id="memory-recall-limit"
                    className="settings-input settings-input-num"
                    type="number"
                    min="1"
                    placeholder="Default"
                    value={draft.memory.recallLimit ?? ''}
                    onChange={(event) => update(['memory', 'recallLimit'], event.target.value ? Number(event.target.value) : undefined)}
                  />
                </SettingRow>
              </SettingsGroup>

              <SettingsGroup
                title="Recall by meaning"
                meta={
                  draft.memory.embedding
                    ? `${draft.memory.embedding.provider === 'ollama' ? 'Local' : 'OpenRouter'}${draft.memory.embedding.model ? ` · ${draft.memory.embedding.model}` : ''}`
                    : 'Off'
                }
              >
                <button className={`settings-choice-row-btn${embeddingMode === 'ollama' ? ' is-selected' : ''}`} type="button" disabled={saving} onClick={() => void startJob('embed-provision')}>
                  <span className="settings-choice-info">
                    <span className="settings-row-label">Use this machine</span>
                    <span className="settings-row-desc">Downloads the local engine (~1.9 GB) and model. Nothing leaves your computer.</span>
                  </span>
                  {embeddingMode === 'ollama' && <Icon name="check" size={15} />}
                </button>
                <button className={`settings-choice-row-btn${embeddingMode === 'openrouter' ? ' is-selected' : ''}`} type="button" disabled={saving} onClick={() => void saveNow((config) => { config.memory.embedding = { provider: 'openrouter' } }, 'Embeddings set to OpenRouter — uses the OpenRouter key from API keys. Restart to apply.')}>
                  <span className="settings-choice-info">
                    <span className="settings-row-label">Use OpenRouter</span>
                    <span className="settings-row-desc">Uses your OpenRouter API key. Notes are sent to OpenRouter for indexing.</span>
                  </span>
                  {embeddingMode === 'openrouter' && <Icon name="check" size={15} />}
                </button>
                <button className={`settings-choice-row-btn${embeddingMode === 'off' ? ' is-selected' : ''}`} type="button" disabled={saving || !draft.memory.embedding} onClick={() => void saveNow((config) => { delete config.memory.embedding }, 'Embeddings off. Restart to apply.')}>
                  <span className="settings-choice-info">
                    <span className="settings-row-label">Off (word matching only)</span>
                    <span className="settings-row-desc">Recall matches exact keywords without embeddings.</span>
                  </span>
                  {embeddingMode === 'off' && <Icon name="check" size={15} />}
                </button>
              </SettingsGroup>

              <SettingsGroup
                title="Notes"
                meta={data.memoryStats ? `${data.memoryStats.facts} fact${data.memoryStats.facts === 1 ? '' : 's'} · ${humanSize(data.memoryStats.bytes)}` : undefined}
                footer="Editing or forgetting a note does not erase past messages, which may still be recalled."
              >
                <div className="settings-row">
                  <div className="settings-search-field">
                    <Icon name="search" size={15} />
                    <input
                      aria-label="Search notes"
                      type="search"
                      placeholder="Search notes…"
                      value={noteQuery}
                      onChange={(event) => { setNoteQuery(event.target.value); setNoteOffset(0) }}
                    />
                  </div>
                </div>
                {notes === null ? (
                  <div className="settings-row"><p className="settings-empty-inline">Reading…</p></div>
                ) : notes.length === 0 ? (
                  <div className="settings-row"><p className="settings-empty-inline">{noteQuery ? 'No notes match your search.' : 'Nothing is remembered yet.'}</p></div>
                ) : (
                  notes.map((note) => (
                    <div className="settings-row settings-note-row" key={note.id}>
                      <div className="settings-row-info">
                        {editingNote === note.id ? (
                          <div className="settings-note-edit">
                            <textarea className="settings-input settings-textarea" aria-label="Note text" value={noteText} onChange={(event) => setNoteText(event.target.value)} />
                            <div className="settings-inline-actions">
                              <button className="button primary settings-btn-sm" type="button" onClick={() => void saveNote(note.id)}>Save</button>
                              <button className="button settings-btn-sm" type="button" onClick={() => setEditingNote(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <div className="settings-row-label">{note.text}</div>
                        )}
                        <p className="settings-row-desc">
                          {formatWhen(note.createdAt)} · <span className="mono">{note.id.slice(0, 8)}</span>
                          {note.source ? (
                            <> · “{note.source.quote}” <button className="settings-inline-link" type="button" onClick={() => onOpenSession(note.source!.session)}>Open session</button></>
                          ) : null}
                        </p>
                      </div>
                      <div className="settings-inline-actions">
                        <button className="button button-icon settings-btn-icon" type="button" title="Edit note" aria-label="Edit note" onClick={() => { setEditingNote(note.id); setNoteText(note.text) }}><Icon name="edit" size={15} /></button>
                        <button className="button button-icon settings-btn-icon" type="button" title="Forget note" aria-label="Forget note" onClick={() => void forgetNote(note.id)}><Icon name="trash" size={15} /></button>
                      </div>
                    </div>
                  ))
                )}
                {(noteOffset > 0 || notesMore) && (
                  <div className="settings-row">
                    <div className="settings-inline-actions">
                      <button className="button settings-btn-sm" type="button" disabled={noteOffset === 0} onClick={() => setNoteOffset(Math.max(0, noteOffset - 50))}>Previous</button>
                      <button className="button settings-btn-sm" type="button" disabled={!notesMore} onClick={() => setNoteOffset(noteOffset + 50)}>Next</button>
                    </div>
                  </div>
                )}
              </SettingsGroup>
            </div>
          </Section>

          {/* ── Permissions ──────────────────────────────────────────── */}
          <Section title="Permissions" description="Control how Milo asks before running tools with side effects." active={current === 'permissions'}>
            <div className="settings-groups-stack">
              <SettingsGroup title="Tool policy">
                <SettingRow
                  label="Approval mode"
                  description={PERMISSION_DESCRIPTIONS[draft.permissions.mode]}
                >
                  <Segmented
                    label="Mode"
                    value={draft.permissions.mode}
                    choices={PERMISSION_MODES.map((value) => ({ value, label: PERMISSION_LABELS[value] }))}
                    onChange={(next) => update(['permissions', 'mode'], next)}
                  />
                </SettingRow>
                <SettingStack
                  label="Always-allowed tools"
                  description="Comma-separated tool names never asked about. Overridden by deny rules."
                  htmlFor="perm-allow"
                >
                  <input
                    id="perm-allow"
                    className="settings-input"
                    placeholder="e.g. read_file, list_dir"
                    value={draft.permissions.allow.join(', ')}
                    onChange={(event) => update(['permissions', 'allow'], splitNames(event.target.value))}
                  />
                </SettingStack>
                <SettingStack
                  label="Blocked tools"
                  description="Comma-separated tool names refused outright unless in YOLO mode."
                  htmlFor="perm-deny"
                >
                  <input
                    id="perm-deny"
                    className="settings-input"
                    placeholder="e.g. shell_command"
                    value={draft.permissions.deny.join(', ')}
                    onChange={(event) => update(['permissions', 'deny'], splitNames(event.target.value))}
                  />
                </SettingStack>
              </SettingsGroup>

              <Disclosure label="Reviewer & classifier" meta="Auto mode threshold & model">
                <SettingsGroup>
                  <SettingRow
                    label="Reviewer threshold"
                    description="Danger score below which a tool runs automatically (default 0.35)."
                    htmlFor="perm-threshold"
                  >
                    <input
                      id="perm-threshold"
                      className="settings-input settings-input-num"
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={draft.permissions.jevThreshold}
                      onChange={(event) => update(['permissions', 'jevThreshold'], Number(event.target.value))}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Classifier backend"
                    badge={<span className="settings-tag">Restart</span>}
                    description="Service used to review tool calls in Auto mode."
                  >
                    <div className="settings-select-wrap">
                      <Select
                        label="Classifier backend"
                        value={draft.classifier.backend}
                        choices={CLASSIFIER_BACKENDS.map((value) => ({ value, label: CLASSIFIER_LABELS[value] }))}
                        onChange={(next) => update(['classifier', 'backend'], next)}
                      />
                    </div>
                  </SettingRow>
                  <SettingStack
                    label="Classifier model"
                    description="Leave empty for the backend’s default."
                    htmlFor="perm-classifier-model"
                  >
                    <input
                      id="perm-classifier-model"
                      className="settings-input"
                      value={draft.classifier.model ?? ''}
                      placeholder="Backend default"
                      onChange={(event) => update(['classifier', 'model'], event.target.value || undefined)}
                    />
                  </SettingStack>
                  <SettingStack
                    label="Classifier URL"
                    description="Custom endpoint override. Empty uses the backend default."
                    htmlFor="perm-classifier-url"
                  >
                    <input
                      id="perm-classifier-url"
                      className="settings-input"
                      value={draft.classifier.url ?? ''}
                      placeholder="Backend default"
                      onChange={(event) => update(['classifier', 'url'], event.target.value || undefined)}
                    />
                  </SettingStack>
                </SettingsGroup>
              </Disclosure>
            </div>
          </Section>

          {/* ── Sessions ─────────────────────────────────────────────── */}
          <Section title="Sessions" description="Context compaction, automatic naming, and saved history." active={current === 'sessions'}>
            <div className="settings-groups-stack">
              <SettingsGroup title="History & compaction">
                <SettingRow
                  label="Compact long sessions automatically"
                  description="Summarize older turns when the context fills up."
                >
                  <Switch
                    label="Compact long sessions automatically"
                    checked={draft.sessions.compaction}
                    onChange={(next) => update(['sessions', 'compaction'], next)}
                  />
                </SettingRow>
                <SettingRow
                  label="Name sessions automatically"
                  description="Generate a short title after the first turn."
                >
                  <Switch
                    label="Name each session from its first turn"
                    checked={draft.sessions.generateTitles}
                    onChange={(next) => update(['sessions', 'generateTitles'], next)}
                  />
                </SettingRow>
                <SettingRow
                  label="Compact at (%)"
                  description="Share of the context window that triggers compaction."
                  htmlFor="sessions-compact-at"
                >
                  <input
                    id="sessions-compact-at"
                    className="settings-input settings-input-num"
                    type="number"
                    min="1"
                    max="100"
                    value={Math.round(draft.sessions.compactAt * 100)}
                    onChange={(event) => update(['sessions', 'compactAt'], Number(event.target.value) / 100)}
                  />
                </SettingRow>
                <SettingRow
                  label="Turns kept verbatim"
                  description="Recent turns preserved word for word during compaction."
                  htmlFor="sessions-keep-turns"
                >
                  <input
                    id="sessions-keep-turns"
                    className="settings-input settings-input-num"
                    type="number"
                    min="1"
                    value={draft.sessions.keepTurns}
                    onChange={(event) => update(['sessions', 'keepTurns'], Number(event.target.value))}
                  />
                </SettingRow>
                <SettingRow
                  label="Sessions kept"
                  description="Maximum saved sessions kept on disk."
                  htmlFor="sessions-max"
                >
                  <input
                    id="sessions-max"
                    className="settings-input settings-input-num"
                    type="number"
                    min="1"
                    value={draft.sessions.maxSessions}
                    onChange={(event) => update(['sessions', 'maxSessions'], Number(event.target.value))}
                  />
                </SettingRow>
              </SettingsGroup>

              <Disclosure label="Advanced" meta="Context overrides & title model">
                <SettingsGroup>
                  <SettingRow
                    label="Fallback budget (tokens)"
                    description="Used only when the model’s context window is unknown."
                    htmlFor="sessions-fallback-budget"
                  >
                    <input
                      id="sessions-fallback-budget"
                      className="settings-input settings-input-num"
                      type="number"
                      min="1024"
                      value={draft.sessions.maxInputTokens}
                      onChange={(event) => update(['sessions', 'maxInputTokens'], Number(event.target.value))}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Context window (tokens)"
                    description="Override the catalog window for an unknown model."
                    htmlFor="sessions-context-window"
                  >
                    <input
                      id="sessions-context-window"
                      className="settings-input settings-input-num"
                      type="number"
                      min="1024"
                      placeholder="Auto"
                      value={draft.sessions.contextWindow ?? ''}
                      onChange={(event) => update(['sessions', 'contextWindow'], event.target.value ? Number(event.target.value) : undefined)}
                    />
                  </SettingRow>
                  <SettingStack
                    label="Title model"
                    description="Model used to name sessions. Empty uses the session’s own model."
                    htmlFor="sessions-title-model"
                  >
                    <input
                      id="sessions-title-model"
                      className="settings-input"
                      value={draft.sessions.titleModel ?? ''}
                      placeholder="Use the main model"
                      onChange={(event) => update(['sessions', 'titleModel'], event.target.value || undefined)}
                    />
                  </SettingStack>
                </SettingsGroup>
              </Disclosure>

              <SettingsGroup title="Saved sessions" meta={`${data.sessions.length}`}>
                {data.sessions.length === 0 ? (
                  <div className="settings-row"><p className="settings-empty-inline">No saved sessions yet.</p></div>
                ) : (
                  data.sessions.map((session) => (
                    <SettingRow
                      key={session.id}
                      label={
                        <>
                          {session.title || session.preview || session.id}
                          {session.id === sessionId && <span className="settings-tag settings-tag-accent">Current</span>}
                        </>
                      }
                      description={`${session.messageCount} msgs · ${formatWhen(session.updatedAt)}`}
                    >
                      <div className="settings-inline-actions">
                        <button className="button settings-btn-sm" type="button" onClick={async () => { await api('resume-session', { chatId, id: session.id }); onSessionChange(session.id) }}>Open</button>
                        {session.backend?.kind !== 'command-code' && (
                          <button className="button button-icon settings-btn-icon" type="button" title="Export markdown" aria-label="Export session" onClick={() => void exportSession(session.id)}><Icon name="download" size={14} /></button>
                        )}
                        {session.id === sessionId
                          ? session.backend?.kind !== 'command-code' && (
                            <button className="button settings-btn-sm" type="button" onClick={async () => { await api('clear-session', { chatId }); await load(); setNotice({ text: 'Session cleared.', error: false }) }}>Clear</button>
                          )
                          : (
                            <button className="button danger button-icon settings-btn-icon" type="button" title="Delete session" aria-label="Delete session" onClick={() => void deleteSession(session.id)}><Icon name="trash" size={14} /></button>
                          )}
                      </div>
                    </SettingRow>
                  ))
                )}
              </SettingsGroup>
            </div>
          </Section>

          {/* ── Gateways ─────────────────────────────────────────────── */}
          <Section title="Gateways" description="Connect Telegram or Discord to talk to Milo from chat apps." active={current === 'gateways'}>
            <div className="settings-groups-stack">
              {(['telegram', 'discord'] as const).map((gateway) => {
                const name = gateway === 'telegram' ? 'Telegram' : 'Discord'
                const enabled = Boolean(draft.gateways[gateway]?.enabled)
                return (
                  <SettingsGroup key={gateway} title={name} meta={enabled ? 'Enabled' : 'Off'}>
                    <SettingRow
                      label={`Enable ${name}`}
                      description={`Add your ${name} bot token under API keys.`}
                    >
                      <Switch
                        label={`Enable ${name}`}
                        checked={enabled}
                        onChange={(next) => update(['gateways', gateway], { enabled: next, allowlist: draft.gateways[gateway]?.allowlist ?? [] })}
                      />
                    </SettingRow>
                    <SettingStack
                      label="Allowed people"
                      description="Comma-separated usernames or IDs. Leave empty to allow anyone who finds the bot."
                      htmlFor={`gateway-${gateway}-allow`}
                    >
                      <input
                        id={`gateway-${gateway}-allow`}
                        className="settings-input"
                        placeholder="Anyone"
                        value={(draft.gateways[gateway]?.allowlist ?? []).join(', ')}
                        onChange={(event) => update(['gateways', gateway], { enabled, allowlist: splitNames(event.target.value) })}
                      />
                    </SettingStack>
                  </SettingsGroup>
                )
              })}
            </div>
          </Section>

          {/* ── Web ──────────────────────────────────────────────────── */}
          <Section title="Web" description="Where this web interface listens when served by Milo." active={current === 'web'}>
            <SettingsGroup
              title="Server"
              footer="Binding outside loopback (127.0.0.1) exposes Milo on your network, protected only by the URL token."
            >
              <SettingRow
                label="Serve with milo serve"
                badge={<span className="settings-tag">Restart</span>}
                description="Start the web UI alongside your chat gateways."
              >
                <Switch
                  label="Serve it with milo serve"
                  checked={draft.web.enabled}
                  onChange={(next) => update(['web', 'enabled'], next)}
                />
              </SettingRow>
              <SettingRow
                label="Bind address"
                description="Network interface to listen on."
                htmlFor="web-host"
              >
                <input
                  id="web-host"
                  className="settings-input settings-input-md"
                  value={draft.web.host}
                  onChange={(event) => update(['web', 'host'], event.target.value)}
                  placeholder="127.0.0.1"
                />
              </SettingRow>
              <SettingRow
                label="Port"
                description="TCP port (0–65535)."
                htmlFor="web-port"
              >
                <input
                  id="web-port"
                  className="settings-input settings-input-num"
                  type="number"
                  min="0"
                  max="65535"
                  value={draft.web.port}
                  onChange={(event) => update(['web', 'port'], Number(event.target.value))}
                />
              </SettingRow>
            </SettingsGroup>
          </Section>

        </div>
        <div
          className={`settings-save${sectionDirty ? ' is-visible' : ''}`}
          aria-hidden={!sectionDirty}
        >
          <span className="settings-save-status">
            <span className="settings-index-dirty-dot" />
            Unsaved changes
          </span>
          <div className="save-actions">
            <button className="button settings-save-discard" type="button" tabIndex={sectionDirty ? undefined : -1} disabled={!sectionDirty || saving} onClick={discardCurrent}>Discard</button>
            <button className="button primary settings-btn-sm" type="button" tabIndex={sectionDirty ? undefined : -1} disabled={!sectionDirty || saving} onClick={() => void saveCurrent()}>{saving ? 'Saving…' : 'Save changes'}</button>
          </div>
        </div>
      </div>}
    </div>}
  </div>
}

/**
 * The sections as a grouped list: a calm column beside the active section on wide
 * screens, and the full-screen index on a phone. Each row carries only its mark and
 * its name — never a duplicate preview of what is configured inside.
 */
function SettingsIndex({ current, isDirty, onSelect, onBack, children }: {
  current: string | null
  isDirty(id: string): boolean
  onSelect(id: string): void
  onBack(): void
  children?: ReactNode
}) {
  const byId = new Map<string, (typeof settingsSections)[number]>(settingsSections.map((entry) => [entry[0], entry]))
  return <nav className="settings-index" aria-label="Settings sections">
    <header className="settings-index-head">
      <button className="settings-strip-back" type="button" aria-label="Back to chat" title="Back to chat" onClick={onBack}><Icon name="arrow-left" size={17} /></button>
      <h1>Settings</h1>
    </header>
    {children}
    <div className="settings-index-groups">
      {settingsSectionGroups.map((group) => (
        <div className="settings-index-group" key={group.label}>
          <div className="settings-index-group-label">{group.label}</div>
          <div className="settings-index-list">
            {group.ids.map((id) => {
              const entry = byId.get(id)
              if (!entry) return null
              const [, icon, label] = entry
              const dirty = isDirty(id)
              return (
                <button
                  type="button"
                  key={id}
                  className={`settings-index-row${current === id ? ' active' : ''}`}
                  aria-current={current === id ? 'page' : undefined}
                  onClick={() => onSelect(id)}
                >
                  <Icon name={icon} size={17} />
                  <span className="settings-index-label">{label}</span>
                  {dirty && <span className="settings-index-dirty-dot" title="Unsaved changes" />}
                  <Icon className="settings-index-chevron" name="chevron" size={15} />
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  </nav>
}

function Section({ title, description, active = false, children }: { title: string; description: string; active?: boolean; children: ReactNode }) {
  const headingId = `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return <section className="settings-section" hidden={!active} aria-labelledby={headingId}>
    <header className="settings-section-head">
      <h2 id={headingId}>{title}</h2>
      <p>{description}</p>
    </header>
    <div className="settings-section-body">{children}</div>
  </section>
}

function JobLog({ job, onClose }: { job: JobView; onClose(): void }) {
  return <div className={`job-panel ${job.status}`} role="status">
    <div className="job-head">
      <span>{job.status === 'running' ? `${job.status} · ${jobLabel(job.kind)}` : job.status === 'done' ? `${jobLabel(job.kind)} — done` : `${jobLabel(job.kind)} — failed`}</span>
      <button className="icon-button" type="button" aria-label="Dismiss" onClick={onClose}><Icon name="x" size={14} /></button>
    </div>
    {job.error && <p className="job-error">{job.error}</p>}
    {job.status === 'done' && job.result?.restart === true && <p className="panel-note">Saved to the config. Restart the web server to apply it.</p>}
    <pre className="job-log">{job.lines.join('\n') || (job.status === 'running' ? 'Working…' : '(no output)')}</pre>
  </div>
}

function useJob(onFinished: () => void): { job: JobView | null; run(kind: string, body: Record<string, unknown>): Promise<void>; clear(): void } {
  const [job, setJob] = useState<JobView | null>(null)
  const timer = useRef<number | null>(null)
  const stop = useCallback(() => {
    if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null }
  }, [])
  useEffect(() => stop, [stop])

  const run = useCallback(async (kind: string, body: Record<string, unknown>): Promise<void> => {
    stop()
    const started = await api<{ id: string }>('job-start', { kind, ...body })
    setJob({ id: started.id, kind, status: 'running', lines: [] })
    timer.current = window.setInterval(() => {
      void api<JobView>('job-status', { id: started.id }).then((view) => {
        setJob(view)
        if (view.status !== 'running') { stop(); onFinished() }
      }).catch(() => undefined)
    }, 700)
  }, [onFinished, stop])

  return { job, run, clear: () => { stop(); setJob(null) } }
}

function jobLabel(kind: string): string {
  return ({ 'browser-install': 'Chrome for Testing', 'profile-copy': 'Copying a profile', 'embed-provision': 'The embedding engine' })[kind] ?? kind
}
