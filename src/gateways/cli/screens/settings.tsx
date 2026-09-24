import { useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import Spinner from 'ink-spinner'
import { readAuth, readConfig, saveAuth, saveConfig } from '../../../core/config/load.js'
import { skillsDir } from '../../../core/config/paths.js'
import type { Auth, Config, GatewayConfig } from '../../../core/config/schema.js'
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS } from '../../../core/providers/types.js'
import { BUILTIN_SKILLS } from '../../../core/skills/builtin.js'
import { SKILLS_DIRECTORY, fetchPopular, type PopularSkill } from '../../../core/skills/catalog.js'
import { ensureSkillsDir } from '../../../core/skills/index.js'
import { installSkill, installedSkillNames, skillsDirFor } from '../../../core/skills/install.js'
import { resolveSource, type ResolvedSkill } from '../../../core/skills/sources.js'
import type { PermissionMode } from '../../../core/tools/permission.js'
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
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', kind: 'provider' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', kind: 'provider' },
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY', kind: 'provider' },
  { id: 'tavily', label: 'Tavily (web search)', env: 'TAVILY_API_KEY', kind: 'search' },
  { id: 'exa', label: 'Exa (web search)', env: 'EXA_API_KEY', kind: 'search' },
  { id: 'parallel', label: 'Parallel (web search)', env: 'PARALLEL_API_KEY', kind: 'search' },
  { id: 'telegram', label: 'Telegram bot', env: 'TELEGRAM_BOT_TOKEN', kind: 'gateway' },
  { id: 'discord', label: 'Discord bot', env: 'DISCORD_BOT_TOKEN', kind: 'gateway' },
]

const SEARCH_CHOICES = ['off', 'tavily', 'exa', 'parallel'] as const
const MODES: PermissionMode[] = ['ask', 'auto', 'yolo']
const TOOL_LEVELS = ['full', 'name', 'off'] as const
/** Cycled in order, starting wherever the current value is. */
const EFFORT_LEVELS = REASONING_EFFORTS
const GATEWAYS: GatewayId[] = ['telegram', 'discord']

/** One run of a hint, when a hint is more than one kind of thing. */
interface MenuHintPart {
  text: string
  color?: string
  bold?: boolean
}

interface MenuItem {
  label: string
  hint?: string
  hintColor?: string
  /**
   * A hint in parts, each with its own weight and colour. An uncoloured part
   * renders in the terminal's own text colour — the most contrast a theme can
   * offer, and the reason `dimColor` is not used on these.
   */
  hintParts?: MenuHintPart[]
}

/** A menu row that can be picked with Space, and installed with Enter. */
interface SkillRow extends MenuItem {
  /** What Space toggles. Rows without one cannot be picked — nothing to install. */
  id?: string
  /** The name to say in the notice. */
  title: string
  install?: () => Promise<ResolvedSkill[]>
}

type FlowStep = 'token' | 'access' | 'enable'

type View =
  | { kind: 'menu' }
  | { kind: 'keys' }
  | { kind: 'keyEdit'; slot: KeySlot }
  | { kind: 'search' }
  | { kind: 'permissions' }
  | { kind: 'permissionEdit'; field: 'threshold' | 'allow' | 'deny' }
  | { kind: 'display' }
  | { kind: 'displayEdit' }
  | { kind: 'gateways' }
  | { kind: 'gatewayFlow'; id: GatewayId; steps: FlowStep[]; step: FlowStep }
  | { kind: 'memory' }
  | { kind: 'skills' }

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
  search: 'Setup · Web search',
  permissions: 'Setup · Tools & permissions',
  permissionEdit: 'Setup · Tools & permissions',
  display: 'Setup · Display',
  displayEdit: 'Setup · Display',
  gateways: 'Setup · Gateways',
  memory: 'Setup · Memory',
  skills: 'Setup · Skills',
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
  const [notice, setNotice] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: these are re-read triggers, not closure values — auth is re-read from disk on navigation and after a save refreshes the config
  const auth = useMemo(() => readAuth(), [view, config])

  /**
   * Setup is where the layout is made: opening it creates the skills directory —
   * the place a `SKILL.md` goes — and reads back what is already there, since an
   * empty directory nobody is told about is the same as no feature.
   */
  const [installed, setInstalled] = useState<string[]>(() => {
    ensureSkillsDir()
    return installedSkillNames(process.cwd())
  })

  /** Writes one row's skills out, and says what happened. */
  const installPicked = async (rows: SkillRow[]): Promise<void> => {
    const done: string[] = []
    const failed: string[] = []

    for (const row of rows) {
      try {
        for (const skill of await row.install!()) {
          await installSkill(skill, skillsDirFor('global', process.cwd()))
        }
        done.push(row.title)
      } catch (error) {
        failed.push(`${row.title}: ${errorMessage(error)}`)
      }
    }

    setInstalled(installedSkillNames(process.cwd()))
    setPicked([])
    setNotice(
      [
        done.length > 0 ? `${done.join(', ')} installed — restart milo to load it.` : '',
        failed.length > 0 ? `Could not install ${failed.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join(' '),
    )
  }

  /**
   * The directory's ranking, read when the section is opened. `null` is "still
   * reading", `[]` is "could not read" — the two say different things, and the
   * bundled skills are offered either way.
   */
  const [popular, setPopular] = useState<PopularSkill[] | null>(null)

  /** The rows picked with Space, by row id. */
  const [picked, setPicked] = useState<string[]>([])

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
    saveConfig(mutate(readConfig() ?? config))
    onSaved()
  }

  const patchConfig = (patch: Partial<Config>) => {
    updateConfig((current) => ({ ...current, ...patch }))
  }

  const patchAuth = (mutate: (auth: Auth) => void) => {
    const current = readAuth()
    mutate(current)
    saveAuth(current)
    onSaved()
  }

  const enabledGateways = GATEWAYS.filter((id) => config.gateways[id]?.enabled)

  const menuItems: MenuItem[] = [
    {
      label: 'Provider & model',
      hint: `${config.provider} · ${config.model}`,
      hintColor: theme.success,
    },
    { label: 'API keys / tokens', hint: 'providers, search, bots' },
    {
      label: 'Web search',
      hint: config.search?.provider ?? 'off',
      hintColor: config.search ? theme.success : undefined,
    },
    {
      label: 'Tools & permissions',
      hint: `mode ${mode}`,
      hintColor: mode === 'ask' ? undefined : mode === 'yolo' ? theme.danger : theme.warning,
    },
    {
      label: 'Display',
      hint: `${config.display.tools} · thinking display ${config.display.thinking}`,
    },
    {
      label: 'Gateways',
      hint: enabledGateways.join(', ') || 'none enabled',
      hintColor: enabledGateways.length > 0 ? theme.success : undefined,
    },
    { label: 'Memory', hint: config.memory.backend },
    {
      label: 'Skills',
      hint: `${installed.length} installed`,
      hintColor: installed.length > 0 ? theme.success : undefined,
    },
    { label: 'Save & exit', hint: 'everything is already saved', hintColor: theme.accent },
  ]

  const displayItems: MenuItem[] = [
    {
      label: 'Tool calls',
      hint: `${config.display.tools} (Enter cycles full → name → off)`,
      hintColor: theme.accent,
    },
    {
      label: 'Thinking display',
      hint: `${config.display.thinking} (Enter toggles on/off)`,
      hintColor: theme.accent,
    },
    {
      label: 'Reasoning effort',
      hint: `${config.reasoningEffort ?? DEFAULT_REASONING_EFFORT} (Enter cycles low → medium → high)`,
      hintColor: theme.accent,
    },
    {
      label: 'Output limit',
      hint: config.maxTokens ? `${config.maxTokens} tokens` : 'wire default (4096 on Anthropic)',
    },
  ]

  const permissionItems: MenuItem[] = [
    {
      label: 'Mode',
      hint: `${mode} (Enter cycles ask → auto → yolo)`,
      hintColor: mode === 'ask' ? undefined : mode === 'yolo' ? theme.danger : theme.warning,
    },
    { label: 'jev threshold', hint: String(config.permissions.jevThreshold), hintColor: theme.accent },
    { label: 'Always allow', hint: config.permissions.allow.join(', ') || '—' },
    { label: 'Never allow', hint: config.permissions.deny.join(', ') || '—' },
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

  /** Step-by-step, like the provider flow: token, access, then enable. */
  const startGatewayFlow = (id: GatewayId) => {
    const needsToken = gatewayTokenState(id) === 'not set'
    const steps: FlowStep[] = needsToken ? ['token', 'access', 'enable'] : ['access', 'enable']
    setNotice(null)
    go({ kind: 'gatewayFlow', id, steps, step: steps[0]! }, needsToken ? '' : accessText(id))
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

  /** The bundled skills, then the directory's most-installed, all one list. */
  const skillRows: SkillRow[] = [
    ...BUILTIN_SKILLS.map((skill) => {
      const here = installed.includes(skill.name)
      const id = `builtin:${skill.name}`
      return {
        // Nothing to pick on one that is already written out; `[x]` says so.
        id: here ? undefined : id,
        title: skill.name,
        label: `${here || picked.includes(id) ? '[x]' : '[ ]'} ${skill.name}`,
        hint: here ? 'installed' : 'ships with Milo',
        hintColor: here ? theme.success : theme.accent,
        install: here ? undefined : async () => [skill],
      }
    }),
    ...(popular ?? []).map((entry) => {
      // The count is the thing to scan for, so it carries the colour and the
      // weight; the summary is prose and renders in the terminal's own text
      // colour, which is the only way to be darker than a palette that is
      // already at the contrast floor on both a light and a dark background.
      const parts: MenuHintPart[] = []
      if (entry.installs) parts.push({ text: entry.installs, color: theme.accent, bold: true })
      if (entry.installs && entry.description) parts.push({ text: ' · ' })
      if (entry.description) {
        parts.push({ text: entry.description, color: theme.secondary })
      }

      return {
        id: entry.source,
        title: `${entry.repo}/${entry.name}`,
        label: `${picked.includes(entry.source) ? '[x]' : '[ ]'} ${entry.repo}/${entry.name}`,
        hint: parts.length > 0 ? undefined : 'most installed',
        hintParts: parts.length > 0 ? parts : undefined,
        install: () => resolveSource(entry.source, { cwd: process.cwd() }),
      }
    }),
  ]

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
          if (index === 0) onOpenModel()
          else if (index === 1) go({ kind: 'keys' })
          else if (index === 2) go({ kind: 'search' })
          else if (index === 3) go({ kind: 'permissions' })
          else if (index === 4) go({ kind: 'display' })
          else if (index === 5) go({ kind: 'gateways' })
          else if (index === 6) go({ kind: 'memory' })
          else if (index === 7) {
            go({ kind: 'skills' })
            void loadPopular()
          } else onClose()
        } else if (key.escape) onClose()
        break

      case 'keys':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(KEY_SLOTS.length - 1, value + 1))
        else if (key.return) {
          const slot = KEY_SLOTS[index]!
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
            go({ kind: 'menu' })
          } else {
            patchConfig({ search: { provider: choice } })
            const slot = KEY_SLOTS.find((entry) => entry.kind === 'search' && entry.id === choice)!
            if (auth.search[choice] || process.env[slot.env]) go({ kind: 'menu' })
            else go({ kind: 'keyEdit', slot })
          }
        } else if (key.escape) go({ kind: 'menu' })
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
            setNotice(`Thinking display: ${thinking} — applies to every surface`)
          } else if (index === 2) {
            const effort =
              EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(config.reasoningEffort) + 1) % EFFORT_LEVELS.length]
            patchConfig({ reasoningEffort: effort })
            setNotice(`Reasoning effort: ${effort} — applies to every surface`)
          } else {
            go({ kind: 'displayEdit' }, config.maxTokens ? String(config.maxTokens) : '')
          }
        } else if (key.escape) go({ kind: 'menu' })
        break

      case 'displayEdit':
        if (key.escape) go({ kind: 'display' })
        break

      case 'gateways':
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(GATEWAYS.length - 1, value + 1))
        else if (key.return) startGatewayFlow(GATEWAYS[index]!)
        else if (key.escape) go({ kind: 'menu' })
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
            setNotice(
              enabled
                ? `${view.id} enabled — it starts with \`milo serve\``
                : `${view.id} disabled — it stops on the next \`milo serve\``,
            )
            go({ kind: 'gateways' })
          } else if (index === 1) {
            go({ ...view, step: 'token' }, '')
          } else {
            go({ ...view, step: 'access' }, accessText(view.id))
          }
        }
        break
      }

      case 'memory':
        if (key.escape) go({ kind: 'menu' })
        break

      case 'skills': {
        if (key.upArrow) setIndex((value) => Math.max(0, value - 1))
        else if (key.downArrow) setIndex((value) => Math.min(skillRows.length - 1, value + 1))
        else if (input === ' ') {
          const row = skillRows[index]
          if (row?.id) {
            const id = row.id
            setPicked((current) =>
              current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
            )
          }
        } else if (key.return) {
          // Enter installs what was picked, not what the cursor is on: picking is
          // the decision, and Enter is the one place it is acted on.
          const chosen = skillRows.filter(
            (row) => row.id && picked.includes(row.id) && row.install,
          )
          if (chosen.length === 0) {
            setNotice('Nothing picked — Space picks a row, Enter installs the picked ones.')
          } else {
            void installPicked(chosen)
          }
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
    }
  }

  /**
   * Esc means "back" everywhere except the hub, where it exits — say both, and
   * say out loud that nothing is pending, so leaving never feels like losing
   * work.
   */
  const footer =
    view.kind === 'keyEdit' || view.kind === 'permissionEdit'
      ? 'Enter save (empty clears) · Esc back'
      : view.kind === 'gatewayFlow' && view.step !== 'enable'
        ? 'Enter save · Esc back'
        : view.kind === 'skills'
          ? '↑/↓ move · Space pick · Enter install what is picked · Esc back'
          : view.kind === 'menu'
            ? '↑/↓ move · Enter open · Esc exit · changes save as you make them'
            : '↑/↓ move · Enter open · Esc back · changes save as you make them'

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
          <Menu
            items={KEY_SLOTS.map((slot) => {
              const state = keyState(slot, auth)
              return {
                label: slot.label,
                hint: `${state} · ${slot.env}`,
                hintColor: state === 'not set' ? theme.danger : theme.success,
              }
            })}
            index={index}
          />
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
        {view.kind === 'permissions' && <Menu items={permissionItems} index={index} />}
        {view.kind === 'display' && (
          <Box flexDirection="column">
            <Menu items={displayItems} index={index} />
            <Box marginTop={1}>
              <Text color={theme.muted}>
                One setting for every surface: the terminal and the bots read the same values.
              </Text>
            </Box>
            {notice && (
              <Box marginTop={1}>
                <Text color={theme.success}>{notice}</Text>
              </Box>
            )}
          </Box>
        )}
        {view.kind === 'gateways' && (
          <Box flexDirection="column">
            <Menu items={gatewayItems} index={index} />
            {notice && (
              <Box marginTop={1}>
                <Text color={theme.success}>{notice}</Text>
              </Box>
            )}
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
        {view.kind === 'memory' && (
          <Box flexDirection="column">
            <Text>
              Backend: <Text color={theme.accent}>{config.memory.backend}</Text>
            </Text>
            <Text color={theme.muted}>
              Local JSON, one file per conversation scope. Third-party backends are pluggable.
            </Text>
          </Box>
        )}

        {view.kind === 'skills' && (
          <Box flexDirection="column">
            <Menu items={skillRows} index={index} />
            <Box marginTop={1} flexDirection="column">
              <Text color={theme.muted}>{skillsDir()}</Text>
              {popular === null ? (
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
                A skill here applies everywhere; .milo/skills inside a project applies to that project
                alone. Milo indexes the names now and reads the instructions only when a task matches,
                so a new one needs a restart.
              </Text>
              <Text color={theme.muted}>
                Third-party skills are instructions, not data — Milo cannot fence them, so read one
                before you install it. The rows below the bundled pair are the directory's ranking,
                not an endorsement: Space picks, Enter installs what is picked.
              </Text>
            </Box>
            {notice && (
              <Box marginTop={1}>
                <Text color={theme.warning}>{notice}</Text>
              </Box>
            )}
          </Box>
        )}

        {(view.kind === 'keyEdit' || view.kind === 'permissionEdit') && (
          <Box flexDirection="column">
            <Text color={theme.accent}>
              {view.kind === 'keyEdit'
                ? `${view.slot.label} — ${view.slot.env} (empty clears)`
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

function Menu({ items, index }: { items: MenuItem[]; index: number }) {
  const labelWidth = Math.max(...items.map((item) => item.label.length), 0)

  return (
    <Box flexDirection="column">
      {items.map((item, itemIndex) => {
        const selected = itemIndex === index
        // One flow of text — so a long hint wraps the way it always did — with
        // the weight and colour set per part. The outer element carries neither:
        // a colour there would be inherited by the hint, which is how the
        // summary used to turn orange on the very row being read.
        return (
          <Text key={item.label}>
            <Text color={selected ? theme.accent : theme.muted}>{selected ? '❯ ' : '  '}</Text>
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
