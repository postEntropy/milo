import path from 'node:path'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'
import {
  chromeVersion,
  copyProfile,
  findChrome,
  findProfiles,
  isDefaultProfile,
  listBrowsers,
  readProfileOrigin,
  tryInstall,
  type FoundBrowser,
  type ProfileOrigin,
  type ProfileSource,
} from '../../../core/browser/index.js'
import { mutateConfig, mutateAuth } from '../../../core/settings.js'
import { readAuth } from '../../../core/config/load.js'
import {
  browserChromeDir,
  browserProfileDir,
  browserProfilesDir,
  DEFAULT_WORKING_DIRECTORY,
  embedEngineDir,
  historyDir,
  memoryDir,
  skillsDir,
} from '../../../core/config/paths.js'
import { connectGoogle } from '../../../core/google/connect.js'
import { googleState } from '../../../core/google/state.js'
import { googleStepsInWords } from '../../../core/google/walkthrough.js'
import { historyStatus } from '../../../core/history.js'
import { DEFAULT_RECALL_LIMIT, memoryStatus } from '../../../core/memory/index.js'
import { provisionEmbedding } from '../../../core/memory/provision.js'
import {
  CLASSIFIER_BACKENDS,
  DEFAULT_CLOUD_EMBED_MODEL,
  DEFAULT_LOCAL_EMBED_MODEL,
  OLLAYA_DEFAULT_MODEL,
  OLLAYA_URL,
  type Auth,
  type ClassifierBackend,
  type Config,
  type GatewayConfig,
} from '../../../core/config/schema.js'
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS } from '../../../core/providers/types.js'
import { BUILTIN_SKILLS } from '../../../core/skills/builtin.js'
import { SKILLS_DIRECTORY, fetchPopular, type PopularSkill } from '../../../core/skills/catalog.js'
import { ensureSkillsDir } from '../../../core/skills/index.js'
import {
  installSkill,
  listInstalled,
  removeSkill,
  skillsDirFor,
  type InstalledSkill,
} from '../../../core/skills/install.js'
import { resolveSource, type ResolvedSkill } from '../../../core/skills/sources.js'
import { googleToolNames } from '../../../core/tools/index.js'
import type { PermissionMode } from '../../../core/tools/permission.js'
import { formatWhen } from '../../../core/sessions/index.js'
import { humanSize, plural, shortenPath } from '../../../util/format.js'
import { resolveToolPath } from '../../../core/tools/walk.js'
import { errorMessage } from '../../../util/errors.js'
import { describeAccess } from '../../access.js'
import { isCtrlC } from '../keys.js'
import { theme } from '../theme.js'

type GatewayId = 'telegram' | 'discord'

interface KeySlot {
  id: string
  label: string
  env: string
  kind: 'provider' | 'search' | 'gateway'
}

const KEY_SLOTS: KeySlot[] = [
  { id: 'commandcode', label: 'Command Code', env: 'COMMANDCODE_API_KEY', kind: 'provider' },
  { id: 'opencode', label: 'OpenCode Zen', env: 'OPENCODE_API_KEY', kind: 'provider' },
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', kind: 'provider' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', kind: 'provider' },
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY', kind: 'provider' },
  { id: 'tavily', label: 'Tavily (web search)', env: 'TAVILY_API_KEY', kind: 'search' },
  { id: 'exa', label: 'Exa (web search)', env: 'EXA_API_KEY', kind: 'search' },
  { id: 'parallel', label: 'Parallel (web search)', env: 'PARALLEL_API_KEY', kind: 'search' },
  { id: 'telegram', label: 'Telegram bot', env: 'TELEGRAM_BOT_TOKEN', kind: 'gateway' },
  { id: 'discord', label: 'Discord bot', env: 'DISCORD_BOT_TOKEN', kind: 'gateway' },
]

/**
 * The key screen is one list but three kinds of thing. The headers say which is
 * which — and the order here is the order the cursor walks them in.
 */
const KEY_GROUPS: { kind: KeySlot['kind']; label: string }[] = [
  { kind: 'provider', label: 'Providers' },
  { kind: 'search', label: 'Web search' },
  { kind: 'gateway', label: 'Gateways' },
]

const SEARCH_CHOICES = ['off', 'tavily', 'exa', 'parallel'] as const
const MODES: PermissionMode[] = ['ask', 'auto', 'yolo']
const TOOL_LEVELS = ['full', 'name', 'off'] as const
/** Cycled in order, starting wherever the current value is. */
const EFFORT_LEVELS = REASONING_EFFORTS
const GATEWAYS: GatewayId[] = ['telegram', 'discord']

/** What a backend answers with when no model is named. */
function defaultClassifierModel(backend: ClassifierBackend): string {
  if (backend === 'ollaya') return `${OLLAYA_DEFAULT_MODEL} (default)`
  if (backend === 'custom') return '—'
  return 'typesafe/jev (default)'
}

/** Where a backend reaches its decision model when no url is named. */
function defaultClassifierUrl(backend: ClassifierBackend): string {
  if (backend === 'ollaya') return `${OLLAYA_URL} (default)`
  // The hosted one rides on the chat provider's own URL.
  return backend === 'custom' ? '— set one' : 'from the provider'
}

/** One run of a hint, when a hint is more than one kind of thing. */
interface MenuHintPart {
  text: string
  color?: string
  bold?: boolean
}

/**
 * One row of the browser picker. Either a browser to run, or a fetch that would
 * produce one — the two are the same list because they are the same decision.
 */
interface BrowserChoice {
  label: string
  hint: string
  hintColor?: string
  header?: boolean
  path?: string
  fetch?: 'chrome'
}

interface MenuItem {
  label: string
  /**
   * A glyph for a row that is a place to go rather than a value to read. Only
   * the hub uses one: inside a section the aligned columns are doing the work,
   * and an icon on every row would be decoration between you and the values.
   */
  icon?: string
  hint?: string
  hintColor?: string
  /**
   * A hint in parts, each with its own weight and colour. An uncoloured part
   * renders in the terminal's own text colour — the most contrast a theme can
   * offer, and the reason `dimColor` is not used on these.
   */
  hintParts?: MenuHintPart[]
  /** A group label above the rows: no cursor, no hint, and never selected. */
  header?: boolean
}

/** A skill row: Space toggles what it should be, Enter writes the change. */
interface SkillRow extends MenuItem {
  /** What Space toggles — a stable key for the row's pending state. */
  id: string
  /** The directory name on disk, which is what a removal deletes. */
  name: string
  /** What the notice calls it. */
  title: string
  /** Whether the skill is on disk right now. */
  installed: boolean
  /** The skills directory that holds it, when installed — what a removal deletes from. */
  root?: string
  /** Resolves the skill(s) to write, for a row that is not installed. */
  install?: () => Promise<ResolvedSkill[]>
}

/** A line under a section, coloured by what it is saying. */
interface Notice {
  text: string
  tone: 'success' | 'warning' | 'danger'
}

type FlowStep = 'token' | 'access' | 'enable'

/**
 * The three things the Google flow does here: name the app, hand over its secret,
 * then wait while the browser answers. The console steps a person does first are
 * a different list, shown whole — counting the two together is what makes a setup
 * feel longer than it is.
 */
type GoogleFlowStep = 'id' | 'secret' | 'waiting'

const GOOGLE_FLOW: GoogleFlowStep[] = ['id', 'secret', 'waiting']

type View =
  | { kind: 'menu' }
  | { kind: 'keys' }
  | { kind: 'keyEdit'; slot: KeySlot }
  | { kind: 'search' }
  | { kind: 'tools' }
  | { kind: 'permissions' }
  | { kind: 'permissionEdit'; field: 'threshold' | 'allow' | 'deny' }
  | { kind: 'classifier' }
  | { kind: 'classifierEdit'; field: 'model' | 'url' }
  | { kind: 'display' }
  | { kind: 'displayEdit' }
  | { kind: 'browser' }
  | { kind: 'browserPick' }
  | { kind: 'browserProfile' }
  | { kind: 'browserProfileConfirm'; source: ProfileSource }
  | { kind: 'browserEdit'; field: 'chromePath' | 'cdpUrl' | 'profileDir' }
  | { kind: 'gateways' }
  | { kind: 'gatewayFlow'; id: GatewayId; steps: FlowStep[]; step: FlowStep }
  | { kind: 'web' }
  | { kind: 'webEdit'; field: 'host' | 'port' }
  | { kind: 'memory' }
  | { kind: 'memoryConfirm' }
  | { kind: 'memoryKey' }
  | { kind: 'skills' }
  | { kind: 'google' }
  | { kind: 'googleFlow'; step: GoogleFlowStep }

export interface SettingsScreenProps {
  config: Config
  mode: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  onOpenModel: () => void
  onSaved: () => void
  onClose: () => void
}

const TITLE: Record<string, string> = {
  menu: 'Setup',
  keys: 'Setup · API keys',
  keyEdit: 'Setup · API keys',
  search: 'Setup · Tools · Web search',
  tools: 'Setup · Tools',
  permissions: 'Setup · Permissions',
  permissionEdit: 'Setup · Permissions',
  classifier: 'Setup · Permissions · Classifier',
  classifierEdit: 'Setup · Permissions · Classifier',
  display: 'Setup · Display',
  displayEdit: 'Setup · Display',
  browser: 'Setup · Tools · Browser',
  browserPick: 'Setup · Tools · Browser',
  browserProfile: 'Setup · Tools · Browser',
  browserProfileConfirm: 'Setup · Tools · Browser',
  browserEdit: 'Setup · Tools · Browser',
  gateways: 'Setup · Gateways',
  web: 'Setup · Web',
  webEdit: 'Setup · Web',
  memory: 'Setup · Memory',
  memoryConfirm: 'Setup · Memory',
  memoryKey: 'Setup · Memory',
  skills: 'Setup · Skills',
  google: 'Setup · Tools · Google',
  googleFlow: 'Setup · Tools · Google',
}

/** Where to get each bot token, shown in the token step. */
const GATEWAY_HINTS: Record<GatewayId, string> = {
  telegram: 'from @BotFather in Telegram',
  discord: 'Discord Developer Portal → Bot → Token',
}

export function SettingsScreen({
  config,
  mode,
  onModeChange,
  onOpenModel,
  onSaved,
  onClose,
}: SettingsScreenProps) {
  const [view, setView] = useState<View>({ kind: 'menu' })
  const [index, setIndex] = useState(0)
  const [text, setText] = useState('')
  const [notices, setNotices] = useState<Notice[]>([])
  // The credentials wait here until there is a grant to write them with: a client
  // id on its own is an app identity, not a connection.
  const [googleClientId, setGoogleClientId] = useState('')
  const [googleUrl, setGoogleUrl] = useState('')

  // biome-ignore lint/correctness/useExhaustiveDependencies: these are re-read triggers, not closure values — auth is re-read from disk on navigation and after a save refreshes the config
  const auth = useMemo(() => readAuth(), [view, config])

  /**
   * Same idea as `auth`: read off disk on navigation. The store is written by
   * turns, not by this screen, so what is on disk is the only honest answer —
   * and the counts are what tells a person whether recall has anything to work
   * with at all.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: view is the re-read trigger, not a closure value
  const memory = useMemo(() => memoryStatus(memoryDir()), [view])

  /** What the log costs, read off disk like the facts above it. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: view is the re-read trigger, not a closure value
  const history = useMemo(() => historyStatus(historyDir()), [view])

  /** The key rows, grouped, plus the cursor map that skips the group headers. */
  const keys = keyLayout(auth)

  /**
   * Setup is where the layout is made: opening it creates the skills directory —
   * the place a `SKILL.md` goes — and reads back what is already there, since an
   * empty directory nobody is told about is the same as no feature.
   */
  const [installed, setInstalled] = useState<InstalledSkill[]>(() => {
    ensureSkillsDir()
    return readInstalled()
  })

  /** Rows whose target state the user changed, by row id. Absent means "as on disk". */
  const [desired, setDesired] = useState<Record<string, boolean>>({})

  /** The skill being written or deleted, while the round trip is in flight. */
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * Which browsers are on this machine, and which one is in use. Probed rather
   * than assumed: a settings row that says "on" while nothing can be launched is
   * how a feature gets blamed for not working.
   */
  const [browser, setBrowser] = useState<{
    hint: string
    path: string | null
    version: string | null
    found: FoundBrowser[]
  }>({ hint: 'checking…', path: null, version: null, found: [] })

  const probeBrowser = useCallback(async (explicit: string | null): Promise<void> => {
    setBrowser({ hint: 'checking…', path: null, version: null, found: [] })
    const found = await listBrowsers()

    const path = await findChrome(explicit)
    if (!path) {
      setBrowser({ hint: 'no Chrome found', path: null, version: null, found })
      return
    }
    const version = await chromeVersion(path)
    const named = found.find((entry) => entry.path === path)?.name ?? 'chrome'
    setBrowser({ hint: version ? `${named} ${version}` : path, path, version, found })
  }, [])

  useEffect(() => {
    void probeBrowser(config.browser.chromePath)
    // Re-probed whenever the value it resolved from changes, which is what
    // naming a different binary — or clearing one — does.
  }, [config.browser.chromePath, probeBrowser])

  /** The profile in use, and whether the browser will refuse to open it. */
  const profilePath = config.browser.profileDir
    ? resolveToolPath(DEFAULT_WORKING_DIRECTORY, config.browser.profileDir)
    : browserProfileDir()
  const profileBlocked = isDefaultProfile(profilePath)

  /** The profiles of the browsers here, read only when the picker is opened. */
  const [profiles, setProfiles] = useState<ProfileSource[]>([])
  /** Where the profile in use was copied from, when it was one of ours. */
  const [profileOrigin, setProfileOrigin] = useState<ProfileOrigin | null>(null)

  useEffect(() => {
    if (!config.browser.profileDir) {
      setProfileOrigin(null)
      return
    }
    let live = true
    void readProfileOrigin(profilePath).then((origin) => {
      if (live) setProfileOrigin(origin)
    })
    return () => {
      live = false
    }
  }, [config.browser.profileDir, profilePath])

  /**
   * Reads the profiles of every browser here. Walking a profile for its size is
   * thousands of stats, so it happens when the picker is opened and never on
   * every render — and the screen names the wait while it runs.
   */
  const loadProfiles = async (): Promise<void> => {
    setNotices([])
    setBusy('reading the browser profiles on this machine…')
    try {
      setProfiles(await findProfiles())
    } finally {
      setBusy(null)
    }
  }

  /**
   * Fetches a browser Milo can own, without a password. The screen names each
   * step while it runs: a download with a silent screen is indistinguishable
   * from one that never started.
   */
  const installBrowser = async (): Promise<void> => {
    setNotices([])
    setBusy('Looking up the current Chrome…')
    const installed = await tryInstall(browserChromeDir(), (line) => setBusy(line))
    setBusy(null)
    if (!installed) {
      setNotices([{ text: 'Could not install a browser — see the line above.', tone: 'danger' }])
      return
    }
    updateConfig((current) => ({
      ...current,
      browser: { ...current.browser, chromePath: installed.path, enabled: true },
    }))
    setBrowser({ hint: `Google Chrome ${installed.version}`, path: installed.path, version: installed.version, found: browser.found })
    setNotices([
      {
        text: `Chrome ${installed.version} ready, and the browser is on — the three tools arrive with the next session`,
        tone: 'success',
      },
    ])
  }

  /**
   * Copies a profile out of a browser the person is signed into, and points Milo
   * at the copy.
   *
   * The copy is the only way that works. A profile cannot be shared with a
   * browser that is already open on it, and a browser refuses to be debugged on
   * its own default directory at all — so this is not a convenience over
   * pointing at the real one, it is the route that exists.
   */
  const adoptProfile = async (source: ProfileSource): Promise<void> => {
    setNotices([])
    const target = path.join(browserProfilesDir(), source.id)
    setBusy(`copying the ${source.name} profile…`)
    try {
      const copied = await copyProfile(source.dir, target, {
        onProgress: (line) => setBusy(line),
        label: source.name,
      })
      updateConfig((current) => ({
        ...current,
        browser: { ...current.browser, profileDir: target, enabled: true },
      }))
      setBusy(null)
      setNotices([
        {
          text: `Copied ${humanSize(copied.bytes)} of ${source.name}'s profile — Milo is signed in where that profile was. Pick it again to refresh the copy.`,
          tone: 'success',
        },
      ])
      go({ kind: 'browser' })
    } catch (error) {
      setBusy(null)
      setNotices([{ text: `Could not copy the profile: ${errorMessage(error)}`, tone: 'danger' }])
    }
  }

  /**
   * Writes the pending changes out: the new skills first, then the removals. A
   * row is acted on only when its target differs from what is on disk, so Enter
   * with nothing toggled does nothing — and says so rather than guessing.
   */
  const applyChanges = async (rows: SkillRow[]): Promise<void> => {
    const wanted = (row: SkillRow) => desired[row.id] ?? row.installed
    const toInstall = rows.filter((row) => wanted(row) && !row.installed && row.install)
    const toRemove = rows.filter((row) => !wanted(row) && row.installed && row.root)

    if (toInstall.length === 0 && toRemove.length === 0) {
      setNotices([
        {
          text: 'Nothing to apply — Space toggles a skill, Enter writes the changes.',
          tone: 'warning',
        },
      ])
      return
    }

    const added: string[] = []
    const gone: string[] = []
    const failed: string[] = []

    for (const row of toInstall) {
      // A lookup is a round trip, and a write is another; naming the wait where
      // it happens is what keeps the screen from reading as stuck.
      setBusy(`Installing ${row.title}…`)
      try {
        for (const skill of await row.install!()) {
          await installSkill(skill, skillsDirFor('global', DEFAULT_WORKING_DIRECTORY))
        }
        added.push(row.title)
      } catch (error) {
        failed.push(`${row.title}: ${errorMessage(error)}`)
      }
    }

    for (const row of toRemove) {
      setBusy(`Removing ${row.title}…`)
      try {
        if (!removeSkill(row.name, row.root!)) throw new Error('it is no longer on disk')
        gone.push(row.title)
      } catch (error) {
        failed.push(`${row.title}: ${errorMessage(error)}`)
      }
    }

    setBusy(null)
    setInstalled(readInstalled())
    setDesired({})

    const outcomes: Notice[] = []
    if (added.length > 0) {
      outcomes.push({ text: `${added.join(', ')} installed — restart milo to load.`, tone: 'success' })
    }
    if (gone.length > 0) {
      outcomes.push({ text: `${gone.join(', ')} removed — restart milo to drop.`, tone: 'success' })
    }
    if (failed.length > 0) {
      outcomes.push({ text: `Could not finish ${failed.join('; ')}`, tone: 'danger' })
    }
    setNotices(outcomes)
  }

  /**
   * The directory's ranking, read when the section is opened. `null` is "still
   * reading", `[]` is "could not read" — the two say different things, and the
   * bundled skills are offered either way.
   */
  const [popular, setPopular] = useState<PopularSkill[] | null>(null)

  const loadPopular = async (): Promise<void> => {
    try {
      setPopular(await fetchPopular(5))
    } catch {
      setPopular([])
    }
  }

  const go = (next: View, initial = '') => {
    setView(next)
    setIndex(0)
    setText(initial)
  }

  /**
   * Every write reads the file back first: each step of a flow must build on
   * what the previous step saved, not on a possibly stale `config` prop.
   */
  const updateConfig = (mutate: (current: Config) => Config) => {
    const result = mutateConfig((current) => {
      const updated = mutate(current)
      Object.assign(current, updated)
    })
    if (!result.ok) {
      setNotices([{ text: `Could not save settings: ${result.error}`, tone: 'danger' }])
      return false
    }
    onSaved()
    return true
  }

  const patchConfig = (patch: Partial<Config>) => {
    updateConfig((current) => ({ ...current, ...patch }))
  }

  /**
   * Turning embeddings on fetches over two gigabytes and leaves a process on a
   * port of its own, so it is put to the person before it happens — the size
   * named, the reason given — the way copying a browser profile is.
   */
  const enableEmbeddings = async () => {
    setNotices([])
    setBusy('looking up the current engine release')
    try {
      const provisioned = await provisionEmbedding({
        dir: embedEngineDir(),
        model: DEFAULT_LOCAL_EMBED_MODEL,
        onProgress: (line) => setBusy(line),
      })
      // Pulled, then let go: the engine is started again by whichever process
      // serves the turns, on the port written down here.
      provisioned.stop()
      updateConfig((current) => ({
        ...current,
        memory: {
          ...current.memory,
          embedding: {
            provider: 'ollama',
            model: provisioned.model,
            url: provisioned.url,
          },
        },
      }))
      setNotices([
        {
          text: `Embeddings on: ${provisioned.model}, engine ${provisioned.version} — everything stays on this machine.`,
          tone: 'success',
        },
      ])
    } catch (error) {
      setNotices([{ text: `Could not set up embeddings: ${errorMessage(error)}`, tone: 'danger' }])
    } finally {
      setBusy(null)
      go({ kind: 'memory' })
    }
  }

  /**
   * Nothing is downloaded and no model runs here, because the vector is computed
   * on the provider's machine. It needs the key that is already there for chat —
   * the same one serves both — and when there is none yet it is asked for right
   * here instead of sending the person to another screen and back.
   */
  const chooseOpenRouter = () => {
    const hasKey = Boolean(
      process.env.OPENROUTER_API_KEY?.trim() || auth.providers.openrouter?.trim(),
    )
    if (hasKey) turnOnOpenRouter()
    else go({ kind: 'memoryKey' }, '')
  }

  /** Writes the hosted choice down. The key, if it had to be typed, is already in. */
  const turnOnOpenRouter = () => {
    updateConfig((current) => ({
      ...current,
      memory: {
        ...current.memory,
        embedding: { provider: 'openrouter', model: DEFAULT_CLOUD_EMBED_MODEL },
      },
    }))
    setNotices([
      {
        text: `Embeddings on: ${DEFAULT_CLOUD_EMBED_MODEL} over OpenRouter — nothing to download, and the notes are sent there to be embedded.`,
        tone: 'success',
      },
    ])
    go({ kind: 'memory' })
  }

  /** Back to words alone. The notes stay; only how they are found changes. */
  const disableEmbeddings = () => {
    const saved = updateConfig((current) => {
      const memory = { ...current.memory }
      delete memory.embedding
      return { ...current, memory }
    })
    if (!saved) return
    setNotices([{ text: 'Embeddings off — recall matches by words only.', tone: 'success' }])
    go({ kind: 'memory' })
  }

  const patchAuth = (mutate: (auth: Auth) => void) => {
    const result = mutateAuth(mutate)
    if (!result.ok) {
      setNotices([{ text: `Could not save credentials: ${result.error}`, tone: 'danger' }])
      return false
    }
    onSaved()
    return true
  }

  const home = process.env.HOME ?? ''

  /**
   * What is in the store, with the effective number spelled out rather than the
   * setting as typed: `recallLimit` left unset still means a number, and a
   * readout that says nothing is a readout nobody can act on.
   */
  const recallLimit = config.memory.recallLimit ?? DEFAULT_RECALL_LIMIT
  const embedding = config.memory.embedding
  const embeddingModel = embedding
    ? (embedding.model ??
      (embedding.provider === 'openrouter' ? DEFAULT_CLOUD_EMBED_MODEL : DEFAULT_LOCAL_EMBED_MODEL))
    : undefined
  const embeddingSource = embedding
    ? embedding.provider === 'openrouter'
      ? 'over OpenRouter'
      : 'on this machine'
    : undefined
  /**
   * Three short lines instead of the essay this used to be. The five sentences
   * it replaced were policy repeated on a screen nobody reads twice, and they
   * buried the one row there was anything to do with.
   */
  const memoryLines = [
    `${memory.facts} facts · ${humanSize(memory.bytes)}`,
    shortenPath(memory.location, home),
    `Answers from the top ${recallLimit}: these facts, and what you said, out of the history.`,
    `${plural(history.files, 'day')} of history · ${humanSize(history.bytes)} — trim it with \`milo history trim\``,
  ]

  const enabledGateways = GATEWAYS.filter((id) => config.gateways[id]?.enabled)

  /**
   * The optional capabilities, one row each. They are the tools the model only
   * gets when they are set up, which is why they are here and not beside the
   * policy that says which tools may run without asking.
   */
  const google = googleState(config, auth)

  const toolsItems: MenuItem[] = [
    {
      label: 'Web search',
      hint: config.search ? config.search.provider : 'off',
      hintColor: config.search ? theme.success : theme.accent,
    },
    {
      label: 'Browser',
      hint: !config.browser.enabled
        ? 'off'
        : browser.hint === 'checking…'
          ? 'checking…'
          : browser.path
            ? browser.hint
            : 'on, but no browser found',
      hintColor: !config.browser.enabled ? theme.accent : browser.path ? theme.success : theme.danger,
    },
    {
      // Named for both halves, because the grant is one and the tools are two
      // pairs: mail and files. The hint is the state, like its neighbours — what
      // to do about it belongs to the panel this opens.
      label: 'Google (Gmail and Drive)',
      hint:
        google.kind === 'off'
          ? 'off'
          : google.kind === 'wanted'
            ? 'on, not connected'
            : `connected as ${google.email ?? 'an account Gmail would not name'}`,
      hintColor: google.kind === 'off' ? theme.accent : google.kind === 'wanted' ? theme.danger : theme.success,
    },
  ]

  /** What is set up, for the hub to say without opening the section. */
  const optionalTools = [
    ...(config.search ? [`web search ${config.search.provider}`] : []),
    ...(config.browser.enabled ? ['browser'] : []),
    ...(config.google.enabled ? ['google'] : []),
  ]
  const toolsHint = optionalTools.join(' · ') || 'none enabled'

  const menuItems: MenuItem[] = [
    {
      icon: '🤖',
      label: 'Provider & model',
      hint: `${config.provider} · ${config.model}`,
      hintColor: theme.success,
    },
    { icon: '🔑',
      label: 'API keys / tokens', hint: 'providers, search, bots' },
    {
      // The optional capabilities, together, because that is the question this
      // screen answers one at a time: which tools does this install have? The
      // policy for running them is a different question, and sits below.
      icon: '🧰',
      label: 'Tools',
      hint: toolsHint,
      hintColor: optionalTools.length > 0 ? theme.success : undefined,
    },
    {
      icon: '🛡️',
      label: 'Permissions',
      hint: `mode ${mode}`,
      hintColor: mode === 'ask' ? undefined : mode === 'yolo' ? theme.danger : theme.warning,
    },
    {
      // The policy's other half: which decision model an auto-mode review is asked
      // of, and where it lives. Both are about what may run, so they sit together.
      icon: '🧭',
      label: 'Classifier',
      hint: config.classifier.model
        ? `${config.classifier.backend} · ${config.classifier.model}`
        : config.classifier.backend,
      hintColor: theme.success,
    },
    {
      icon: '👁️',
      label: 'Display',
      hint: `${config.display.tools} · thinking display ${config.display.thinking}`,
    },
    {
      icon: '📡',
      label: 'Gateways',
      hint: enabledGateways.join(', ') || 'none enabled',
      hintColor: enabledGateways.length > 0 ? theme.success : undefined,
    },
    {
      // The fourth surface. It is here rather than in the Gateways list because
      // it has no token to paste and no allowlist: it is a server on this
      // machine, and what it needs told is where to listen.
      icon: '🌐',
      label: 'Web',
      hint: config.web.enabled ? `on · ${config.web.host}:${config.web.port}` : 'off',
      hintColor: config.web.enabled ? theme.success : undefined,
    },
    { icon: '🧠',
      label: 'Memory', hint: memory.backend },
    {
      icon: '📘',
      label: 'Skills',
      hint: `${installed.length} installed`,
      hintColor: installed.length > 0 ? theme.success : undefined,
    },
    { icon: '🚪',
      label: 'Save & exit', hint: 'everything is already saved', hintColor: theme.accent },
  ]

  const displayItems: MenuItem[] = [
    {
      label: 'Tool calls',
      hint: `${config.display.tools} (full → name → off)`,
      hintColor: theme.accent,
    },
    {
      label: 'Thinking display',
      hint: `${config.display.thinking} (on/off)`,
      hintColor: theme.accent,
    },
    {
      label: 'Reasoning effort',
      hint: `${config.reasoningEffort ?? DEFAULT_REASONING_EFFORT} (low → medium → high)`,
      hintColor: theme.accent,
    },
    {
      label: 'Output limit',
      hint: config.maxTokens ? `${config.maxTokens} tokens` : 'wire default (4096 on Anthropic)',
    },
  ]

  const browserItems: MenuItem[] = [
    {
      label: 'Enabled',
      hint: config.browser.enabled ? 'on' : 'off',
      hintColor: theme.accent,
    },
    {
      // Not "Browser": the section is already called that, and a row that repeats
      // its own section's name says nothing about what it controls.
      label: 'Browser to run',
      // Just the browser: that another one can be picked here, or downloaded,
      // is what the row does when you press Enter — which the footer says.
      hint: browser.hint,
      hintColor: browser.path ? theme.success : theme.warning,
    },
    {
      label: 'Window',
      hint: config.browser.headless ? 'headless' : 'visible',
      hintColor: theme.accent,
    },
    {
      // Where the sign-ins live. A default profile is the one case the browser
      // refuses outright, so it says so here rather than failing at launch.
      label: 'Profile',
      hint: profileBlocked
        ? `${config.browser.profileDir} — the browser will not open its own default profile for debugging`
        : profileOrigin
          ? `copied from ${profileOrigin.label ?? path.basename(profileOrigin.from)} on ${profileOrigin.at.slice(0, 10)}`
          : config.browser.profileDir
            ? config.browser.profileDir
            : 'its own — sign in once and it is kept',
      hintColor: profileBlocked ? theme.danger : theme.accent,
    },
    {
      label: 'Connection',
      hint: config.browser.cdpUrl ? `attached to ${config.browser.cdpUrl}` : 'a browser of its own',
      hintColor: theme.accent,
    },
    {
      label: 'Binary',
      hint: config.browser.chromePath ?? 'found on PATH',
    },
    {
      label: 'Snapshots kept',
      hint: `${config.browser.keepSnapshots} in context (0 → 1 → 2 → 4)`,
      hintColor: theme.accent,
    },
  ]

  /**
   * Its own, a copy of a profile already signed in, or a directory named by hand.
   * Flat rather than grouped: the list is three rows on most machines and a
   * header over one of them is a label doing no work.
   */
  const profilePickItems: MenuItem[] = [
    {
      label: 'Its own',
      hint: config.browser.profileDir
        ? 'start clean — sign in once and it is kept'
        : 'in use — sign in once and it is kept',
      hintColor: config.browser.profileDir ? theme.accent : theme.success,
    },
    ...profiles.map((profile) => ({
      label: profile.name,
      // Three different kinds of fact, three colours: what is in there to copy,
      // how much of it there is, and where it lives.
      hintParts: [
        profile.cookieStore
          ? {
              text: `${humanSize(profile.cookieStore.bytes)} of cookies, written ${formatWhen(profile.cookieStore.at)}`,
              color: theme.success,
            }
          : { text: 'no cookie store — nothing to be signed in with', color: theme.warning },
        { text: ` · copies ${Math.round(profile.bytes / 1_048_576)} MB`, color: theme.secondary },
        { text: ` · ${shortenPath(profile.dir, process.env.HOME ?? '')}`, color: theme.muted },
      ],
    })),
    { label: 'Name a directory…', hint: 'a profile somewhere else on this machine', hintColor: theme.accent },
  ]

  /**
   * The browsers on this machine, and the way to get one when there is none.
   *
   * Kept as data rather than only as rows, because the row that is picked and
   * the browser it picks have to stay in step — and because one of these rows is
   * not a browser yet, it is the download that produces one.
   */
  const browserChoices: BrowserChoice[] = [
    ...browser.found.map((entry) => ({
      label: entry.name,
      hint: entry.path === browser.path ? `in use · ${entry.path}` : entry.path,
      hintColor: entry.path === config.browser.chromePath ? theme.success : undefined,
      path: entry.path,
    })),
    ...(browser.found.length === 0
      ? [{ label: 'Nothing found on this machine', hint: 'fetch one below', header: true }]
      : []),
    {
      label: 'Download a Chrome for Testing',
      hint: 'no installer, no sudo',
      hintColor: theme.accent,
      fetch: 'chrome' as const,
    },
  ]

  const browserPickItems: MenuItem[] = browserChoices.map((choice) => ({
    label: choice.label,
    hint: choice.hint,
    hintColor: choice.hintColor,
    ...(choice.header ? { header: true } : {}),
  }))

  const permissionItems: MenuItem[] = [
    {
      label: 'Mode',
      hint: `${mode} (ask → auto → yolo)`,
      hintColor: mode === 'ask' ? undefined : mode === 'yolo' ? theme.danger : theme.warning,
    },
    { label: 'jev threshold', hint: String(config.permissions.jevThreshold), hintColor: theme.accent },
    { label: 'Always allow', hint: config.permissions.allow.join(', ') || '—' },
    { label: 'Never allow', hint: config.permissions.deny.join(', ') || '—' },
  ]

  /**
   * Where the decision model lives. Only the hosted backend rides on the chat
   * provider; a local Ollaya or a custom endpoint stands on its own, which is why
   * this is not a field of the provider.
   */
  const classifierItems: MenuItem[] = [
    {
      label: 'Backend',
      hint: `${config.classifier.backend} (commandcode → ollaya → custom)`,
      hintColor: theme.accent,
    },
    {
      label: 'Model',
      hint: config.classifier.model ?? defaultClassifierModel(config.classifier.backend),
    },
    {
      label: 'URL',
      hint: config.classifier.url ?? defaultClassifierUrl(config.classifier.backend),
      hintColor: config.classifier.url ? undefined : theme.muted,
    },
  ]

  const gatewayTokenState = (id: GatewayId): string =>
    keyState(KEY_SLOTS.find((slot) => slot.id === id)!, auth)

  const gatewayBase = (id: GatewayId): GatewayConfig =>
    config.gateways[id] ?? { enabled: false, allowlist: [] }

  const accessText = (id: GatewayId): string => gatewayBase(id).allowlist.join(', ')

  const patchGateway = (id: GatewayId, patch: Partial<GatewayConfig>) => {
    updateConfig((current) => ({
      ...current,
      gateways: {
        ...current.gateways,
        [id]: { ...(current.gateways[id] ?? { enabled: false, allowlist: [] }), ...patch },
      },
    }))
  }

  const gatewayItems: MenuItem[] = GATEWAYS.map((id) => ({
    label: id,
    hint: `${config.gateways[id]?.enabled ? 'enabled' : 'disabled'} · token ${gatewayTokenState(id)} · ${describeAccess(gatewayBase(id).allowlist)}`,
    hintColor: config.gateways[id]?.enabled ? theme.success : theme.danger,
  }))

  /** The web UI: a server here, not a bot out there — so it is told where to listen, not who may talk. */
  const webItems: MenuItem[] = [
    {
      label: 'Serve with `milo serve`',
      hint: config.web.enabled ? 'on' : 'off',
      hintColor: config.web.enabled ? theme.success : theme.danger,
    },
    { label: 'Address', hint: config.web.host },
    { label: 'Port', hint: String(config.web.port) },
  ]

  /** Step-by-step, like the provider flow: token, access, then enable. */
  const startGatewayFlow = (id: GatewayId) => {
    const needsToken = gatewayTokenState(id) === 'not set'
    const steps: FlowStep[] = needsToken ? ['token', 'access', 'enable'] : ['access', 'enable']
    setNotices([])
    go({ kind: 'gatewayFlow', id, steps, step: steps[0]! }, needsToken ? '' : accessText(id))
  }

  /** What a connected account can still do about it: consent again, or drop the grant. */
  const googleActionItems: MenuItem[] = [
    { label: 'Reconnect', hint: 'consent again, with the same app' },
    { label: 'Forget', hint: 'drops the grant, keeps the app identity' },
  ]

  /**
   * The flow, off disk and back: `connectGoogle` owns the protocol and this screen
   * only shows where it got to.
   *
   * Reconnecting skips the two fields, the way the command does — the app identity
   * is already stored, and asking for it again would be asking for something we
   * have.
   */
  const startGoogleFlow = () => {
    setNotices([])
    const stored = auth.google
    if (stored?.clientId && stored.clientSecret) {
      void runGoogleConnect(stored.clientId, stored.clientSecret)
      return
    }
    go({ kind: 'googleFlow', step: 'id' }, stored?.clientId ?? '')
  }

  const runGoogleConnect = async (clientId: string, clientSecret: string) => {
    go({ kind: 'googleFlow', step: 'waiting' })
    setGoogleUrl('')
    setBusy('waiting for Google to answer on this machine…')

    const connected = await connectGoogle({ clientId, clientSecret, onUrl: setGoogleUrl })
    setBusy(null)

    if (!connected.ok) {
      // Back to the secret with the reason on screen: the app identity is usually
      // right and the secret usually isn't.
      setNotices([{ text: connected.error, tone: 'danger' }])
      go({ kind: 'googleFlow', step: 'secret' }, '')
      return
    }

    const { account, enabledInConfig, warning } = connected.value
    onSaved()
    go({ kind: 'google' })
    setNotices([
      ...(warning ? [{ text: warning, tone: 'warning' as const }] : []),
      {
        // Said here because it is true here: the tools are registered when the
        // runtime starts, so a connection made in this screen is not in the
        // catalog yet.
        text: `Connected${account.email ? ` as ${account.email}` : ''} — restart Milo for the tools to appear`,
        tone: 'success' as const,
      },
      ...(enabledInConfig
        ? [{ text: '`google.enabled` turned on in the config', tone: 'success' as const }]
        : []),
    ])
  }

  const forgetGoogle = () => {
    patchAuth((current) => {
      delete current.google
    })
    go({ kind: 'google' })
    setNotices([
      { text: 'Grant dropped — the tools will answer that Milo is not connected.', tone: 'success' },
    ])
  }

  const gatewayActionItems = (id: GatewayId): MenuItem[] => [
    {
      label: config.gateways[id]?.enabled ? 'Disable' : 'Enable',
      hint: config.gateways[id]?.enabled
        ? 'stops on the next `milo serve`'
        : 'starts with `milo serve`',
      hintColor: config.gateways[id]?.enabled ? theme.danger : theme.success,
    },
    { label: 'Change token', hint: 'paste a new one' },
    { label: 'Change access', hint: describeAccess(gatewayBase(id).allowlist) },
  ]

  /** The skills directory holding each installed skill, by name — what a removal needs. */
  const installedRoots = new Map(
    installed.map((skill) => [skill.name, path.dirname(skill.dir)]),
  )

  /** The names already offered above, so an installed one is not listed twice. */
  const offered = new Set([
    ...BUILTIN_SKILLS.map((skill) => skill.name),
    ...(popular ?? []).map((entry) => entry.name),
  ])

  /**
   * The checkbox is the skill's state, not a selection: `[x]` means it is (or
   * will be) installed, and Space unchecks it to ask for a removal. The tag
   * beside it names what Enter would do, so unchecking never reads as a no-op.
   */
  const withState = (row: SkillRow): SkillRow => {
    const want = desired[row.id] ?? row.installed
    const parts = row.hintParts ?? []
    const tag =
      want === row.installed
        ? row.installed
          ? { text: 'installed', color: theme.success }
          : null
        : want
          ? { text: 'install', color: theme.accent }
          : { text: 'remove', color: theme.danger }

    return {
      ...row,
      label: `${want ? '[x]' : '[ ]'} ${row.label}`,
      // The separator rides on the tag: two identical ` · ` parts would collide
      // as React keys, and the tag is the one that always leads the hint.
      hintParts: tag
        ? [{ ...tag, text: parts.length > 0 ? `${tag.text} · ` : tag.text }, ...parts]
        : parts.length > 0
          ? parts
          : undefined,
    }
  }

  /** The bundled skills, the directory's ranking, then anything installed elsewhere. */
  const skillRows: SkillRow[] = [
    ...BUILTIN_SKILLS.map((skill) => {
      const root = installedRoots.get(skill.name)
      return {
        id: `builtin:${skill.name}`,
        name: skill.name,
        title: skill.name,
        installed: root !== undefined,
        root,
        label: skill.name,
        hintParts: [
          { text: skill.description, color: theme.secondary },
          ...(root === undefined ? [{ text: ' · ships with Milo', color: theme.muted }] : []),
        ],
        install: root === undefined ? async () => [skill] : undefined,
      }
    }),
    ...(popular ?? []).map((entry) => {
      // The count is the thing to scan for, so it carries the colour and the
      // weight; the summary is prose and renders in the terminal's own text
      // colour, which is the only way to be darker than a palette that is
      // already at the contrast floor on both a light and a dark background.
      const root = installedRoots.get(entry.name)
      const parts: MenuHintPart[] = []
      if (entry.installs) parts.push({ text: entry.installs, color: theme.accent, bold: true })
      if (entry.installs && entry.description) parts.push({ text: ' · ' })
      if (entry.description) {
        parts.push({ text: entry.description, color: theme.secondary })
      }

      return {
        id: entry.source,
        name: entry.name,
        title: `${entry.repo}/${entry.name}`,
        installed: root !== undefined,
        root,
        label: `${entry.repo}/${entry.name}`,
        hintParts: parts.length > 0 ? parts : [{ text: 'most installed', color: theme.muted }],
        install:
          root === undefined
            ? () => resolveSource(entry.source, { cwd: DEFAULT_WORKING_DIRECTORY })
            : undefined,
      }
    }),
    // A skill put there by `milo skills add`, or by hand, is still one to remove
    // — and the ranking only ever shows five, so it would otherwise be invisible.
    ...installed
      .filter((skill) => !offered.has(skill.name))
      .map((skill) => ({
        id: `installed:${skill.name}`,
        name: skill.name,
        title: skill.name,
        installed: true,
        root: path.dirname(skill.dir),
        label: skill.name,
        hintParts: [{ text: skill.description, color: theme.secondary }],
      })),
  ].map(withState)

  useInput((input, key) => {
    if (isCtrlC(input, key)) {
      onClose()
      return
    }

    switch (view.kind) {
      case 'menu':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(menuItems.length - 1, value + 1))
        else if (key.return) {
          // A section starts clean: the last section's notice is not this one's.
          setNotices([])
          if (index === 0) onOpenModel()
          else if (index === 1) go({ kind: 'keys' })
          else if (index === 2) go({ kind: 'tools' })
          else if (index === 3) go({ kind: 'permissions' })
          else if (index === 4) go({ kind: 'classifier' })
          else if (index === 5) go({ kind: 'display' })
          else if (index === 6) go({ kind: 'gateways' })
          else if (index === 7) go({ kind: 'web' })
          else if (index === 8) go({ kind: 'memory' })
          else if (index === 9) {
            // Opening the section starts from what is on disk, not from whatever
            // was toggled before it was last left.
            setDesired({})
            go({ kind: 'skills' })
            void loadPopular()
          } else onClose()
        } else if (key.escape) onClose()
        break

      case 'tools':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(toolsItems.length - 1, value + 1))
        else if (key.return) {
          setNotices([])
          if (index === 0) go({ kind: 'search' })
          else if (index === 1) {
            // Probing is a subprocess, so the section opens on what is already
            // known and refreshes itself.
            void probeBrowser(config.browser.chromePath)
            go({ kind: 'browser' })
          } else go({ kind: 'google' })
        } else if (key.escape) go({ kind: 'menu' })
        break

      case 'keys':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(keys.order.length - 1, value + 1))
        else if (key.return) {
          const slot = keys.order[index]!
          const current = slot.kind === 'provider' ? auth.providers[slot.id] : slot.kind === 'search' ? auth.search[slot.id] : auth.gateways[slot.id]
          go({ kind: 'keyEdit', slot }, current ?? '')
        } else if (key.escape) go({ kind: 'menu' })
        break

      case 'keyEdit':
        if (key.escape) go({ kind: 'keys' })
        break

      case 'search':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(SEARCH_CHOICES.length - 1, value + 1))
        else if (key.return) {
          const choice = SEARCH_CHOICES[index]!
          if (choice === 'off') {
            patchConfig({ search: undefined })
            go({ kind: 'tools' })
          } else {
            patchConfig({ search: { provider: choice } })
            const slot = KEY_SLOTS.find((entry) => entry.kind === 'search' && entry.id === choice)!
            if (auth.search[choice] || process.env[slot.env]) go({ kind: 'tools' })
            else go({ kind: 'keyEdit', slot })
          }
        } else if (key.escape) go({ kind: 'tools' })
        break

      case 'permissions':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(permissionItems.length - 1, value + 1))
        else if (key.return) {
          if (index === 0) {
            const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length]!
            // The shell owns persistence for the mode, so there is one writer.
            onModeChange(next)
          } else if (index === 1) {
            go({ kind: 'permissionEdit', field: 'threshold' }, String(config.permissions.jevThreshold))
          } else if (index === 2) {
            go({ kind: 'permissionEdit', field: 'allow' }, config.permissions.allow.join(', '))
          } else {
            go({ kind: 'permissionEdit', field: 'deny' }, config.permissions.deny.join(', '))
          }
        } else if (key.escape) go({ kind: 'menu' })
        break

      case 'permissionEdit':
        if (key.escape) go({ kind: 'permissions' })
        break

      case 'classifier':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(classifierItems.length - 1, value + 1))
        else if (key.return) {
          if (index === 0) {
            const backend =
              CLASSIFIER_BACKENDS[
                (CLASSIFIER_BACKENDS.indexOf(config.classifier.backend) + 1) % CLASSIFIER_BACKENDS.length
              ]!
            patchConfig({ classifier: { ...config.classifier, backend } })
            setNotices([
              {
                // The reviewer is built once at startup, so a backend switch is a
                // restart away, the way the browser and the embedding engine are.
                text:
                  backend === 'custom'
                    ? 'Classifier: custom — set a URL below; applies on the next start'
                    : `Classifier: ${backend} — applies on the next start`,
                tone: backend === 'custom' ? 'warning' : 'success',
              },
            ])
          } else if (index === 1) {
            go({ kind: 'classifierEdit', field: 'model' }, config.classifier.model ?? '')
          } else {
            go({ kind: 'classifierEdit', field: 'url' }, config.classifier.url ?? '')
          }
        } else if (key.escape) go({ kind: 'menu' })
        break

      case 'classifierEdit':
        if (key.escape) go({ kind: 'classifier' })
        break

      case 'display':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(displayItems.length - 1, value + 1))
        else if (key.return) {
          if (index === 0) {
            const next = TOOL_LEVELS[(TOOL_LEVELS.indexOf(config.display.tools) + 1) % TOOL_LEVELS.length]!
            patchConfig({ display: { ...config.display, tools: next } })
          } else if (index === 1) {
            const thinking = config.display.thinking === 'on' ? 'off' : 'on'
            patchConfig({ display: { ...config.display, thinking } })
            setNotices([{ text: `Thinking display: ${thinking} — applies to every surface`, tone: 'success' }])
          } else if (index === 2) {
            const effort =
              EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(config.reasoningEffort) + 1) % EFFORT_LEVELS.length]
            patchConfig({ reasoningEffort: effort })
            setNotices([{ text: `Reasoning effort: ${effort} — applies to every surface`, tone: 'success' }])
          } else {
            go({ kind: 'displayEdit' }, config.maxTokens ? String(config.maxTokens) : '')
          }
        } else if (key.escape) go({ kind: 'menu' })
        break

      case 'displayEdit':
        if (key.escape) go({ kind: 'display' })
        break

      case 'browser':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(browserItems.length - 1, value + 1))
        else if (key.return) {
          if (index === 0) {
            const enabled = !config.browser.enabled
            patchConfig({ browser: { ...config.browser, enabled } })
            setNotices([
              {
                text: enabled
                  ? 'Browser: on — the three browser tools are added to the catalog from the next session'
                  : 'Browser: off — the model no longer sees the browser tools',
                tone: 'success',
              },
            ])
          } else if (index === 1) {
            setNotices([])
            void probeBrowser(config.browser.chromePath)
            go({ kind: 'browserPick' })
          } else if (index === 2) {
            const headless = !config.browser.headless
            patchConfig({ browser: { ...config.browser, headless } })
            setNotices([{ text: `Browser window: ${headless ? 'headless' : 'visible'}`, tone: 'success' }])
          } else if (index === 3) {
            void loadProfiles()
            go({ kind: 'browserProfile' })
          } else if (index === 4) {
            go({ kind: 'browserEdit', field: 'cdpUrl' }, config.browser.cdpUrl ?? '')
          } else if (index === 5) {
            go({ kind: 'browserEdit', field: 'chromePath' }, config.browser.chromePath ?? '')
          } else {
            const choices = [0, 1, 2, 4]
            const next = choices[(choices.indexOf(config.browser.keepSnapshots) + 1) % choices.length] ?? 2
            patchConfig({ browser: { ...config.browser, keepSnapshots: next } })
            setNotices([
              {
                text: `Page snapshots in context: ${next} — the older ones become a one-line note`,
                tone: 'success',
              },
            ])
          }
        } else if (key.escape) go({ kind: 'tools' })
        break

      case 'browserProfile': {
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(profilePickItems.length - 1, value + 1))
        else if (key.return) {
          const picked = profiles[index - 1]
          if (index === 0) {
            patchConfig({ browser: { ...config.browser, profileDir: null } })
            setNotices([{ text: 'Profile: Milo\u2019s own — sign in to it once and it is kept', tone: 'success' }])
            go({ kind: 'browser' })
          } else if (picked) {
            // A copy is a real side effect with a real consequence, so it is put
            // to the person before it happens rather than after.
            go({ kind: 'browserProfileConfirm', source: picked })
          } else {
            go({ kind: 'browserEdit', field: 'profileDir' }, '')
          }
        } else if (key.escape) go({ kind: 'browser' })
        break
      }

      case 'browserProfileConfirm': {
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(1, value + 1))
        else if (key.return) {
          if (index === 0) void adoptProfile(view.source)
          else go({ kind: 'browserProfile' })
        } else if (key.escape) go({ kind: 'browserProfile' })
        break
      }

      case 'browserPick': {
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(browserPickItems.length - 1, value + 1))
        else if (key.return) {
          const chosen = browserChoices[index]
          if (!chosen || chosen.header) break
          // Two of these rows are not a browser yet — they are the fetch that
          // produces one, which is why they are in the same list.
          if (chosen.fetch === 'chrome') {
            void installBrowser()
            return
          }
          if (!chosen.path) break
          patchConfig({ browser: { ...config.browser, chromePath: chosen.path } })
          setNotices([{ text: `Browser: ${chosen.label} at ${chosen.path}`, tone: 'success' }])
          void probeBrowser(chosen.path)
          go({ kind: 'browser' })
        } else if (key.escape) go({ kind: 'browser' })
        break
      }

      case 'browserEdit':
        if (key.escape) go({ kind: 'browser' })
        break

      case 'gateways':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(GATEWAYS.length - 1, value + 1))
        else if (key.return) startGatewayFlow(GATEWAYS[index]!)
        else if (key.escape) go({ kind: 'menu' })
        break

      case 'web':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(webItems.length - 1, value + 1))
        else if (key.return) {
          setNotices([])
          if (index === 0) patchConfig({ web: { ...config.web, enabled: !config.web.enabled } })
          else if (index === 1) go({ kind: 'webEdit', field: 'host' }, config.web.host)
          else go({ kind: 'webEdit', field: 'port' }, String(config.web.port))
        } else if (key.escape) go({ kind: 'menu' })
        break

      case 'webEdit':
        if (key.escape) go({ kind: 'web' })
        break

      case 'gatewayFlow': {
        if (key.escape) {
          go({ kind: 'gateways' })
          break
        }
        if (view.step !== 'enable') break

        const actions = gatewayActionItems(view.id)
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(actions.length - 1, value + 1))
        else if (key.return) {
          if (index === 0) {
            const enabled = !config.gateways[view.id]?.enabled
            patchGateway(view.id, { enabled })
            setNotices([
              {
                text: enabled
                  ? `${view.id} enabled — it starts with \`milo serve\``
                  : `${view.id} disabled — it stops on the next \`milo serve\``,
                tone: 'success',
              },
            ])
            go({ kind: 'gateways' })
          } else if (index === 1) {
            go({ ...view, step: 'token' }, '')
          } else {
            go({ ...view, step: 'access' }, accessText(view.id))
          }
        }
        break
      }

      case 'google': {
        if (busy) break
        if (key.escape) {
          go({ kind: 'tools' })
          break
        }
        if (google.kind !== 'connected') {
          if (key.return) startGoogleFlow()
          break
        }
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(googleActionItems.length - 1, value + 1))
        else if (key.return) {
          if (index === 0) startGoogleFlow()
          else forgetGoogle()
        }
        break
      }

      case 'googleFlow':
        // While the browser is the thing to act on, this screen is a report.
        if (view.step === 'waiting') break
        if (key.escape) go({ kind: 'google' })
        break

      case 'memory':
        if (busy) break
        if (key.escape) go({ kind: 'menu' })
        else if (key.return) go({ kind: 'memoryConfirm' })
        break

      case 'memoryConfirm': {
        if (busy) break
        // Three ways to turn it on, two to turn it off.
        const last = config.memory.embedding ? 1 : 2
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(last, value + 1))
        else if (key.return) {
          if (config.memory.embedding) {
            if (index === 0) disableEmbeddings()
            else go({ kind: 'memory' })
          } else if (index === 0) void enableEmbeddings()
          else if (index === 1) chooseOpenRouter()
          else go({ kind: 'memory' })
        } else if (key.escape) go({ kind: 'memory' })
        break
      }

      case 'memoryKey':
        if (key.escape) go({ kind: 'memoryConfirm' })
        break

      case 'skills': {
        // A write is in flight: the keys would race it, so the screen is read-only
        // until it lands. Ctrl+C still gets out, above.
        if (busy) break
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(skillRows.length - 1, value + 1))
        else if (input === ' ') {
          const row = skillRows[index]
          if (row) {
            const id = row.id
            const here = row.installed
            setDesired((current) => ({ ...current, [id]: !(current[id] ?? here) }))
          }
        } else if (key.return) {
          // Enter writes what the toggles asked for — installs and removals
          // together — and nothing at all when nothing was toggled.
          void applyChanges(skillRows)
        } else if (key.escape) go({ kind: 'menu' })
        break
      }

      default:
        break
    }
  })

  const saveText = (value: string) => {
    if (view.kind === 'keyEdit') {
      const slot = view.slot
      patchAuth((current) => {
        const trimmed = value.trim()
        if (slot.kind === 'provider') {
          if (trimmed) current.providers[slot.id] = trimmed
          else delete current.providers[slot.id]
        } else if (slot.kind === 'search') {
          if (trimmed) current.search[slot.id] = trimmed
          else delete current.search[slot.id]
        } else {
          if (trimmed) current.gateways[slot.id] = trimmed
          else delete current.gateways[slot.id]
        }
      })
      go({ kind: 'menu' })
      return
    }

    if (view.kind === 'browserEdit') {
      const trimmed = value.trim()
      const field = view.field
      // Empty means "decide it yourself": its own binary, its own profile, or a
      // browser already running — each something the person opts into by typing.
      updateConfig((current) => ({ ...current, browser: { ...current.browser, [field]: trimmed || null } }))
      go({ kind: 'browser' })
      if (field === 'chromePath') {
        void probeBrowser(trimmed || null)
      } else if (field === 'profileDir' && trimmed) {
        const expanded = resolveToolPath(DEFAULT_WORKING_DIRECTORY, trimmed)
        setNotices([
          isDefaultProfile(expanded)
            ? {
                text: `${expanded} is a browser's own default profile — Chrome will ignore the debugging port on it. Copy it somewhere else, or sign in to Milo's own profile instead.`,
                tone: 'danger',
              }
            : { text: `Profile: ${expanded} — cookies from it are what Milo will be signed in with`, tone: 'success' },
        ])
      }
      return
    }

    if (view.kind === 'googleFlow' && view.step === 'id') {
      const id = value.trim()
      if (!id) return
      setGoogleClientId(id)
      go({ ...view, step: 'secret' }, '')
      return
    }

    if (view.kind === 'googleFlow' && view.step === 'secret') {
      const secret = value.trim()
      if (!secret) return
      void runGoogleConnect(googleClientId, secret)
      return
    }

    if (view.kind === 'gatewayFlow' && view.step === 'token') {
      const id = view.id
      const trimmed = value.trim()
      if (trimmed) {
        patchAuth((current) => {
          current.gateways[id] = trimmed
        })
      }
      go({ ...view, step: 'access' }, accessText(id))
      return
    }

    if (view.kind === 'gatewayFlow' && view.step === 'access') {
      const allowlist = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
      patchGateway(view.id, { allowlist })
      go({ ...view, step: 'enable' })
      return
    }

    if (view.kind === 'memoryKey') {
      const trimmed = value.trim()
      if (!trimmed) return
      // The slot a chat provider's key lives in, so the one key serves both.
      patchAuth((current) => {
        current.providers.openrouter = trimmed
      })
      turnOnOpenRouter()
      return
    }

    if (view.kind === 'displayEdit') {
      const tokens = Number(value.trim())
      // Empty means "leave it to the wire"; anything else has to be a real
      // ceiling, since a bad value would be rejected by the provider.
      patchConfig(
        Number.isFinite(tokens) && tokens > 0
          ? { maxTokens: Math.floor(tokens) }
          : { maxTokens: undefined },
      )
      go({ kind: 'display' })
      return
    }

    if (view.kind === 'webEdit') {
      if (view.field === 'host') {
        const host = value.trim() || '127.0.0.1'
        updateConfig((current) => ({ ...current, web: { ...current.web, host } }))
        const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
        setNotices([
          loopback
            ? { text: `The web UI binds to ${host} — reachable from this machine only`, tone: 'success' }
            : {
                text: `${host} is not loopback, so the web UI is reachable from the network. The token in its URL is then the only thing in the way.`,
                tone: 'danger',
              },
        ])
      } else {
        const port = Number(value.trim())
        if (Number.isInteger(port) && port >= 0 && port <= 65535) {
          updateConfig((current) => ({ ...current, web: { ...current.web, port } }))
          setNotices([{ text: `The web UI listens on port ${port}`, tone: 'success' }])
        } else {
          // Kept, not saved as something the server cannot bind: a bad value here
          // would be a web UI that silently never starts.
          setNotices([{ text: `"${value.trim()}" is not a port — the previous one stands`, tone: 'danger' }])
        }
      }
      go({ kind: 'web' })
      return
    }

    if (view.kind === 'permissionEdit') {
      const parsed = value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
      const permissions = { ...config.permissions }
      if (view.field === 'threshold') {
        const threshold = Number(value.trim())
        if (Number.isFinite(threshold)) permissions.jevThreshold = Math.min(1, Math.max(0, threshold))
      } else if (view.field === 'allow') {
        permissions.allow = parsed
      } else {
        permissions.deny = parsed
      }
      patchConfig({ permissions })
      go({ kind: 'permissions' })
      return
    }

    if (view.kind === 'classifierEdit') {
      const trimmed = value.trim()
      // Empty means "use the backend's own": its default model, or its default URL.
      const classifier = { ...config.classifier }
      if (view.field === 'model') classifier.model = trimmed || undefined
      else classifier.url = trimmed || undefined
      patchConfig({ classifier })
      go({ kind: 'classifier' })
    }
  }

  /**
   * Esc means "back" everywhere except the hub, where it exits — say both, and
   * say out loud that nothing is pending, so leaving never feels like losing
   * work.
   */
  // Esc goes up one level, which from a section two deep is two presses to get
  // anywhere — so every screen also names the key that leaves outright. It was
  // always there and never written down, which is the same as not being there.
  const EXIT = 'Ctrl+C exit'
  const footer =
    view.kind === 'memoryKey' ||
    view.kind === 'keyEdit' ||
    view.kind === 'permissionEdit' ||
    view.kind === 'classifierEdit'
      ? `Enter save (empty clears) · Esc back · ${EXIT}`
      : view.kind === 'gatewayFlow' && view.step !== 'enable'
        ? `Enter save · Esc back · ${EXIT}`
        : view.kind === 'skills'
          ? `↑/↓ move · Space install/remove · Enter apply · Esc back · ${EXIT}`
          : view.kind === 'menu'
            ? '↑/↓ move · Enter open · Esc exit · changes save as you make them'
            : `↑/↓ move · Enter change · Esc back · ${EXIT} · changes save as you make them`

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>
          Milo
        </Text>
        <Text color={theme.muted}>
          {' · '}
          {view.kind === 'gatewayFlow' ? `Setup · ${view.id}` : (TITLE[view.kind] ?? 'Setup')}
        </Text>
      </Box>

      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        {view.kind === 'menu' && <Menu items={menuItems} index={index} />}
        {view.kind === 'keys' && (
          <Menu items={keys.items} index={keys.positions[index] ?? 0} />
        )}
        {view.kind === 'search' && (
          <Menu
            items={SEARCH_CHOICES.map((choice) => {
              const current = choice === (config.search?.provider ?? 'off')
              return {
                label: choice,
                hint: current ? 'current' : '',
                hintColor: current ? theme.success : undefined,
              }
            })}
            index={index}
          />
        )}
        {view.kind === 'tools' && (
          <Box flexDirection="column">
            <Menu items={toolsItems} index={index} />
            <Box marginTop={1}>
              <Text color={theme.muted}>
                Each one is a tool the model only gets once it is set up: off means absent from the
                catalog, not present and failing. What may run without asking is under Permissions.
              </Text>
            </Box>
            <Notices notices={notices} />
          </Box>
        )}
        {view.kind === 'permissions' && <Menu items={permissionItems} index={index} />}
        {view.kind === 'classifier' && (
          <Box flexDirection="column">
            <Menu items={classifierItems} index={index} />
            <Box marginTop={1}>
              <Text color={theme.muted}>
                The decision model an auto-mode review is asked of. The hosted jev rides on the
                chat provider; a local Ollaya or a custom endpoint stands on its own. A switch
                takes effect when Milo next starts.
              </Text>
            </Box>
            <Notices notices={notices} />
          </Box>
        )}
        {view.kind === 'display' && (
          <Box flexDirection="column">
            <Menu items={displayItems} index={index} />
            <Box marginTop={1}>
              <Text color={theme.muted}>
                One setting for every surface: the terminal and the bots read the same values.
              </Text>
            </Box>
            <Notices notices={notices} />
          </Box>
        )}
        {view.kind === 'browser' && (
          <Box flexDirection="column">
            <Menu items={browserItems} index={index} />
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>
                {config.browser.enabled
                  ? 'The model gets browser_open, browser_snapshot and browser_act — a real Chromium over the DevTools protocol, not a screenshot of one.'
                  : 'Off: the browser tools are not in the catalog at all, so the model never sees them.'}
              </Text>
              {profileBlocked ? (
                <Text color={theme.danger}>
                  That profile is a browser's own default one, and Chrome 136 and later ignore the
                  debugging port there without saying so. Point this at a copy instead — a profile
                  cannot be shared with a browser that is already open on it anyway.
                </Text>
              ) : null}
              {busy ? (
                <Box>
                  <Spinner type="dots" />
                  <Text color={theme.warning}> {busy}</Text>
                </Box>
              ) : null}
            </Box>
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'browserProfileConfirm' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              Copy the {view.source.name} profile into Milo's own directory?
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>From   {shortenPath(view.source.dir, home)}</Text>
              <Text color={theme.muted}>
                To     {shortenPath(path.join(browserProfilesDir(), view.source.id), home)}
              </Text>
              <Text color={theme.muted}>
                Takes  {humanSize(view.source.bytes)} of files — the caches, which are most of a
                profile, are left behind
              </Text>
            </Box>
            <Box marginTop={1}>
              <Text color={theme.warning}>
                Milo will then be signed in as you on every site that profile is, in every
                conversation it serves. The copy is private and stays on this machine.
              </Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>
                Rather not have Milo's browser signed in as you? Go back and leave it on its own
                profile: signed in nowhere, nothing copied.
              </Text>
            </Box>
            <Box marginTop={1}>
              <Menu
                items={[
                  { label: 'Copy it', hint: 'and run the browser on the copy', hintColor: theme.accent },
                  { label: 'Cancel', hint: 'nothing is copied — the browser stays signed in nowhere' },
                ]}
                index={index}
              />
            </Box>
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'browserProfile' && (
          <Box flexDirection="column">
            <Text color={theme.muted}>
              A profile of your own is copied, never shared: the browser refuses to be debugged on
              its default directory, and cannot be opened on one another browser is already using.
            </Text>
            <Menu items={profilePickItems} index={index} />
            {busy ? (
              <Box>
                <Spinner type="dots" />
                <Text color={theme.warning}> {busy}</Text>
              </Box>
            ) : null}
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'browserPick' && (
          <Box flexDirection="column">
            <Text color={theme.muted}>
              Every Chromium on this machine — any of them speaks the DevTools protocol. Firefox does
              not, and would need a driver of its own.
            </Text>
            <Menu items={browserPickItems} index={index} />
            {busy ? (
              <Box>
                <Spinner type="dots" />
                <Text color={theme.warning}> {busy}</Text>
              </Box>
            ) : null}
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'browserEdit' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              {view.field === 'cdpUrl'
                ? 'Attach to a browser already running — a ws:// URL, or host:port of its devtools endpoint. Empty to start one of Milo’s own.'
                : view.field === 'profileDir'
                  ? 'The profile directory to run on. Empty for Milo’s own. A copy of a real profile carries its sign-ins; a browser’s default profile does not work at all.'
                  : 'The Chrome or Chromium binary to run. Empty to choose from what is installed.'}
            </Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput key={view.field} value={text} onChange={setText} onSubmit={saveText} />
            </Box>
          </Box>
        )}

        {view.kind === 'gateways' && (
          <Box flexDirection="column">
            <Menu items={gatewayItems} index={index} />
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'web' && (
          <Box flexDirection="column">
            <Menu items={webItems} index={index} />
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>
                The browser chat, started by `milo serve` and opened at the URL it prints.
              </Text>
              <Text color={theme.muted}>
                Loopback by default. `milo serve --no-web` skips it for one run; the address and
                port can also be overridden with `milo web --host` and `--port`.
              </Text>
            </Box>
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'webEdit' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              {view.field === 'host'
                ? 'The address the web UI binds to. 127.0.0.1 keeps it on this machine; 0.0.0.0 accepts every interface it is reached on.'
                : 'The port the web UI listens on. 0 lets the system pick a free one.'}
            </Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput key={view.field} value={text} onChange={setText} onSubmit={saveText} />
            </Box>
          </Box>
        )}

        {view.kind === 'gatewayFlow' && view.step === 'token' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              Step {view.steps.indexOf(view.step) + 1} of {view.steps.length} — {view.id} bot token
            </Text>
            <Text color={theme.muted}>({GATEWAY_HINTS[view.id]})</Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput key={view.step} value={text} onChange={setText} onSubmit={saveText} mask="*" />
            </Box>
          </Box>
        )}

        {view.kind === 'gatewayFlow' && view.step === 'access' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              Step {view.steps.indexOf(view.step) + 1} of {view.steps.length} — who can talk to{' '}
              {view.id}?
            </Text>
            <Text color={theme.muted}>
              User or chat ids, comma-separated. Empty means anyone. Message the bot to see your id.
            </Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput key={view.step} value={text} onChange={setText} onSubmit={saveText} />
            </Box>
          </Box>
        )}

        {view.kind === 'gatewayFlow' && view.step === 'enable' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              Step {view.steps.indexOf(view.step) + 1} of {view.steps.length} — what should Milo do
              with {view.id}?
            </Text>
            <Menu items={gatewayActionItems(view.id)} index={index} />
          </Box>
        )}

        {view.kind === 'google' && (
          <Box flexDirection="column">
            {google.kind === 'connected' ? (
              <>
                <Text color={theme.success}>
                  Connected as {google.email ?? 'an account Gmail would not name'}
                  {google.connectedAt ? ` since ${google.connectedAt.slice(0, 10)}` : ''}
                </Text>
                <Box marginTop={1}>
                  <Text color={theme.muted}>
                    Read-only: {googleToolNames(auth.google ?? null).join(', ')} — nothing writes.
                  </Text>
                </Box>
                <Box marginTop={1}>
                  <Menu items={googleActionItems} index={index} />
                </Box>
                {!google.enabled && (
                  <Box marginTop={1}>
                    <Text color={theme.warning}>
                      `google.enabled` is off in the config, so the tools are not registered.
                    </Text>
                  </Box>
                )}
              </>
            ) : (
              <>
                <Text color={theme.muted}>
                  Google needs an OAuth client of your own. Once, at this machine:
                </Text>
                <Box marginTop={1} flexDirection="column">
                  {googleStepsInWords().map((line) => (
                    <Text key={line} color={line.trim().startsWith('http') ? theme.accent : theme.muted}>
                      {line}
                    </Text>
                  ))}
                </Box>
                <Box marginTop={1}>
                  <Text color={theme.muted}>
                    Milo reads only: mail and files, and nothing here writes.
                  </Text>
                </Box>
                <Box marginTop={1}>
                  <Menu
                    items={[{ label: 'Connect', hint: 'paste the client id and secret' }]}
                    index={0}
                  />
                </Box>
              </>
            )}
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'googleFlow' && view.step === 'id' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              Step {GOOGLE_FLOW.indexOf(view.step) + 1} of {GOOGLE_FLOW.length} — the client id of
              your OAuth app
            </Text>
            <Text color={theme.muted}>
              From the "Desktop app" client in the Cloud console, the one ending in
              .apps.googleusercontent.com
            </Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput key={view.step} value={text} onChange={setText} onSubmit={saveText} />
            </Box>
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'googleFlow' && view.step === 'secret' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              Step {GOOGLE_FLOW.indexOf(view.step) + 1} of {GOOGLE_FLOW.length} — its client secret
            </Text>
            <Text color={theme.muted}>
              Milo keeps it to refresh the grant. It is never shown again.
            </Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput
                key={view.step}
                value={text}
                onChange={setText}
                onSubmit={saveText}
                mask="*"
              />
            </Box>
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'googleFlow' && view.step === 'waiting' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              Step {GOOGLE_FLOW.indexOf(view.step) + 1} of {GOOGLE_FLOW.length} — open this in a
              browser, on this machine, and allow the read-only access
            </Text>
            <Box marginTop={1}>
              <Text color={theme.accent}>{googleUrl || 'waiting for a port on this machine…'}</Text>
            </Box>
            <Box marginTop={1}>
              <Text color={theme.muted}>
                <Spinner type="dots" /> {busy}
              </Text>
            </Box>
          </Box>
        )}
        {view.kind === 'memory' && (
          <Box flexDirection="column">
            {/* One row, the way every other section has one: the thing to press
                Enter on is a line with the cursor on it, not a sentence below. */}
            <Menu
              items={[
                embedding
                  ? {
                      label: 'Recall by meaning',
                      hint: `${embeddingModel} ${embeddingSource}`,
                      hintColor: theme.success,
                    }
                  : { label: 'Recall by meaning', hint: 'off' },
              ]}
              index={index}
            />
            <Box marginTop={1} flexDirection="column">
              {memoryLines.map((line) => (
                <Text key={line} color={theme.muted}>
                  {line}
                </Text>
              ))}
            </Box>
            {busy ? (
              <Box>
                <Spinner type="dots" />
                <Text color={theme.warning}> {busy}</Text>
              </Box>
            ) : null}
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'memoryConfirm' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              {config.memory.embedding
                ? 'Go back to matching by words alone?'
                : 'Where should recall by meaning come from?'}
            </Text>
            <Box marginTop={1}>
              {/* Each way carries its own price on its own row. A paragraph above
                  naming both was the same thing twice, and less readable. */}
              <Menu
                items={
                  config.memory.embedding
                    ? [
                        { label: 'Turn it off', hint: 'recall matches by words again' },
                        { label: 'Cancel' },
                      ]
                    : [
                        {
                          label: 'Local engine',
                          hint: 'about 1.9 GB once — nothing leaves this machine',
                        },
                        {
                          label: 'OpenRouter',
                          hint: 'no download, uses your key — the notes are sent out',
                        },
                        { label: 'Cancel' },
                      ]
                }
                index={index}
              />
            </Box>
            <Box marginTop={1}>
              <Text color={theme.muted}>
                {config.memory.embedding
                  ? 'Notes are kept either way; recall goes back to words only.'
                  : 'Reversible at any time. Changing the model writes the vectors again.'}
              </Text>
            </Box>
            {busy ? (
              <Box>
                <Spinner type="dots" />
                <Text color={theme.warning}> {busy}</Text>
              </Box>
            ) : null}
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'memoryKey' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>OpenRouter key</Text>
            <Text color={theme.muted}>
              Paste it here — it is kept with your other keys, and chat models use the same one.
            </Text>
            <Box marginTop={1}>
              <Text color={theme.accent}>❯ </Text>
              <TextInput value={text} onChange={setText} onSubmit={saveText} mask="*" />
            </Box>
            <Notices notices={notices} />
          </Box>
        )}

        {view.kind === 'skills' && (
          <Box flexDirection="column">
            <Menu items={skillRows} index={index} />
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>{skillsDir()}</Text>
              {busy ? (
                <Text color={theme.warning}>
                  <Spinner type="dots" /> {busy}
                </Text>
              ) : popular === null ? (
                // Same shape as the chat's busy line: waiting on a round trip is
                // named where the wait is, or it reads as the screen being stuck.
                <Text color={theme.warning}>
                  <Spinner type="dots" /> Reading {SKILLS_DIRECTORY}…
                </Text>
              ) : popular.length === 0 ? (
                <Text color={theme.muted}>
                  Could not read {SKILLS_DIRECTORY} — only the ones that ship with Milo are listed.
                </Text>
              ) : null}
              <Text color={theme.muted}>
                A skill here applies everywhere; .milo/skills in a project applies to that project
                alone, and a new one is read at startup.
              </Text>
              <Text color={theme.muted}>
                Ranked by installs, not reviewed: a skill is instructions Milo will obey and cannot
                fence, so read one before installing it.
              </Text>
            </Box>
            <Notices notices={notices} />
          </Box>
        )}

        {(view.kind === 'keyEdit' || view.kind === 'permissionEdit' || view.kind === 'classifierEdit') && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              {view.kind === 'keyEdit'
                ? `${view.slot.label} — ${view.slot.env} (empty clears)`
                : view.kind === 'classifierEdit'
                  ? `${view.field === 'model' ? 'Classifier model' : 'Classifier URL'} (empty uses the backend default)`
                  : view.field === 'threshold'
                    ? 'jev threshold (0..1)'
                    : `${view.field === 'allow' ? 'Always allow' : 'Never allow'} (comma-separated tool names)`}
            </Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput
                value={text}
                onChange={setText}
                onSubmit={saveText}
                mask={view.kind === 'keyEdit' ? '*' : undefined}
              />
            </Box>
          </Box>
        )}

        {view.kind === 'displayEdit' && (
          <Box flexDirection="column">
            <Text color={theme.accent}>Output token ceiling (empty leaves it to the wire)</Text>
            <Text color={theme.muted}>
              The Anthropic wire defaults to 4096, which cuts a long answer or a big file in half.
            </Text>
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput value={text} onChange={setText} onSubmit={saveText} />
            </Box>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>{footer}</Text>
      </Box>
    </Box>
  )
}

/** A glyph so the outcome reads before the sentence does. */
const NOTICE_GLYPH: Record<Notice['tone'], string> = {
  success: '✓',
  warning: '!',
  danger: '✗',
}

/**
 * The lines under a section: one outcome each, so a success and a failure never
 * run together — and boxed in the tone's own colour, since a write that landed
 * is the one thing on the screen worth looking at.
 */
function Notices({ notices }: { notices: Notice[] }) {
  if (notices.length === 0) return null

  return (
    <Box marginTop={1} flexDirection="column">
      {notices.map((notice) => (
        <Box key={notice.text} borderStyle="round" borderColor={theme[notice.tone]} paddingX={1}>
          <Text bold color={theme[notice.tone]}>
            {NOTICE_GLYPH[notice.tone]} {notice.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function Menu({ items, index }: { items: MenuItem[]; index: number }) {
  // Headers are labels, not rows: the cursor never lands on one, and leaving them
  // out of the width keeps the values beside the rows aligned in a column.
  const labelWidth = Math.max(
    ...items.filter((item) => !item.header).map((item) => item.label.length),
    0,
  )
  // A blank gutter on a list that never uses icons is three columns of nothing.
  const icons = items.some((item) => item.icon)

  return (
    <Box flexDirection="column">
      {items.map((item, itemIndex) => {
        if (item.header) {
          return (
            <Box key={item.label} marginTop={itemIndex === 0 ? 0 : 1}>
              <Text bold color={theme.secondary}>
                {item.label}
              </Text>
            </Box>
          )
        }

        const selected = itemIndex === index
        // One flow of text — so a long hint wraps the way it always did — with
        // the weight and colour set per part. The outer element carries neither:
        // a colour there would be inherited by the hint, which is how the
        // summary used to turn orange on the very row being read.
        return (
          <Text key={item.label}>
            <Text color={selected ? theme.accent : theme.muted}>{selected ? '❯ ' : '  '}</Text>
            {icons ? <Text>{item.icon ? `${item.icon} ` : '   '}</Text> : null}
            <Text bold={selected} color={selected ? theme.accent : undefined}>
              {item.label.padEnd(labelWidth)}
            </Text>
            {item.hintParts ? (
              <Text>
                {'  '}
                {item.hintParts.map((part) => (
                  // The parts of one hint are distinct by construction — a count,
                  // a separator and a sentence — so the text is a stable key.
                  <Text key={part.text} bold={part.bold} color={part.color}>
                    {part.text}
                  </Text>
                ))}
              </Text>
            ) : item.hint ? (
              <Text dimColor={!item.hintColor} color={item.hintColor}>{`  ${item.hint}`}</Text>
            ) : null}
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * What is installed globally. A project scope appears only after a project is
 * selected; launching Milo from a directory does not select one.
 */
function readInstalled(): InstalledSkill[] {
  return listInstalled(skillsDirFor('global', DEFAULT_WORKING_DIRECTORY))
}

/**
 * The key rows with their group headers, and the map the cursor needs: `order`
 * is the slots in the order they are shown, and `positions[i]` is where the i-th
 * one sits in the rendered list once the headers are counted in.
 */
function keyLayout(auth: Auth): { items: MenuItem[]; order: KeySlot[]; positions: number[] } {
  const items: MenuItem[] = []
  const order: KeySlot[] = []
  const positions: number[] = []

  for (const group of KEY_GROUPS) {
    items.push({ label: group.label, header: true })
    for (const slot of KEY_SLOTS.filter((entry) => entry.kind === group.kind)) {
      const state = keyState(slot, auth)
      positions.push(items.length)
      order.push(slot)
      items.push({
        label: slot.label,
        hint: `${state} · ${slot.env}`,
        hintColor: state === 'not set' ? theme.danger : theme.success,
      })
    }
  }

  return { items, order, positions }
}

function keyState(slot: KeySlot, auth: Auth): string {
  if (slot.kind === 'provider') {
    if (process.env[slot.env]) return `env ${slot.env}`
    return auth.providers[slot.id] ? 'stored' : 'not set'
  }
  if (slot.kind === 'search') {
    if (process.env[slot.env]) return `env ${slot.env}`
    return auth.search[slot.id] ? 'stored' : 'not set'
  }
  if (process.env[slot.env]) return `env ${slot.env}`
  return auth.gateways[slot.id] ? 'stored' : 'not set'
}
