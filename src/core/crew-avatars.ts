import { COLOR_PALETTE_IDS, type ColorPaletteId } from './color-palettes.js'

export const CREW_AVATAR_SHAPES = ['orb', 'pebble', 'capsule', 'droplet', 'puff', 'gem', 'dome', 'star'] as const
export const CREW_AVATAR_EYES = ['capsule', 'happy', 'curious', 'visor', 'wink', 'spark'] as const
export const CREW_AVATAR_ACCESSORIES = ['none', 'antenna', 'sprout', 'glasses', 'headphones', 'crown'] as const

/** Normalizes an explicit mention handle (stripping leading `@` and lowercasing). */
export function normalizeBotHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase()
}

/** Derives a clean ASCII slug from a display name when no explicit handle was given. */
export function slugifyBotHandle(name: string): string {
  const ascii = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 36)
  return ascii && /^[a-z0-9]/.test(ascii) ? ascii : 'bot'
}

export type CrewAvatarShape = (typeof CREW_AVATAR_SHAPES)[number]
export type CrewAvatarEyes = (typeof CREW_AVATAR_EYES)[number]
export type CrewAvatarAccessory = (typeof CREW_AVATAR_ACCESSORIES)[number]

export interface CrewAvatar {
  shape: CrewAvatarShape
  eyes: CrewAvatarEyes
  accessory: CrewAvatarAccessory
  palette: ColorPaletteId
}

function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Deterministic Dot/Grok-style companion traits derived from a bot's identity. */
export function defaultBotAvatar(id: string, name = ''): CrewAvatar {
  const h1 = hashSeed(`${id}:${name}`)
  const h2 = hashSeed(`${name}:${id}:eyes`)
  const h3 = hashSeed(`${id}:acc:${name}`)
  const h4 = hashSeed(`${name}:pal:${id}`)
  return {
    shape: CREW_AVATAR_SHAPES[h1 % CREW_AVATAR_SHAPES.length]!,
    eyes: CREW_AVATAR_EYES[h2 % CREW_AVATAR_EYES.length]!,
    accessory: CREW_AVATAR_ACCESSORIES[h3 % CREW_AVATAR_ACCESSORIES.length]!,
    palette: COLOR_PALETTE_IDS[h4 % COLOR_PALETTE_IDS.length]!,
  }
}

/** Picks a new avatar trait combination, avoiding repeating the current silhouette/eyes/palette. */
export function shuffleBotAvatar(
  current?: CrewAvatar,
  pick: (length: number) => number = (length) => Math.floor(Math.random() * length),
): CrewAvatar {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next: CrewAvatar = {
      shape: CREW_AVATAR_SHAPES[pick(CREW_AVATAR_SHAPES.length)]!,
      eyes: CREW_AVATAR_EYES[pick(CREW_AVATAR_EYES.length)]!,
      accessory: CREW_AVATAR_ACCESSORIES[pick(CREW_AVATAR_ACCESSORIES.length)]!,
      palette: COLOR_PALETTE_IDS[pick(COLOR_PALETTE_IDS.length)] as ColorPaletteId,
    }
    if (!current || next.shape !== current.shape || next.eyes !== current.eyes || next.palette !== current.palette) {
      return next
    }
  }
  return defaultBotAvatar(`${Date.now()}:${pick(1_000_000)}`)
}

const EYE_GLYPHS: Record<CrewAvatarEyes, string> = {
  capsule: '▮▮',
  happy: '^^',
  curious: 'oO',
  visor: '▬▬',
  wink: '-•',
  spark: '✦✦',
}

/** Compact text badge for terminal and chat gateways. */
export function formatBotAvatarBadge(avatar: CrewAvatar): string {
  return `[${EYE_GLYPHS[avatar.eyes]} ${avatar.palette} ${avatar.shape}${avatar.accessory !== 'none' ? ` + ${avatar.accessory}` : ''}]`
}

interface ToolBotPreview {
  id: string
  name: string
  task?: string
  mission?: string
  model?: string
  report?: string
  avatar: CrewAvatar
}

export interface KnownBotAvatar {
  id: string
  name: string
  handle?: string
  avatar?: Partial<CrewAvatar>
}

function resolveKnownBot(
  explicitId: string | undefined,
  name: string,
  knownBots?: ReadonlyArray<KnownBotAvatar>,
): KnownBotAvatar | undefined {
  if (!knownBots || knownBots.length === 0) return undefined
  if (explicitId) {
    const byId = knownBots.find((bot) => bot.id === explicitId)
    if (byId) return byId
  }
  const target = name.trim().toLowerCase()
  const normalizedTarget = target.replace(/^@+/, '')
  const byName = knownBots.filter((bot) => bot.name.trim().toLowerCase() === target)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) return byName[0]
  return knownBots.find((bot) => bot.handle && bot.handle.toLowerCase() === normalizedTarget)
}

function readInputField(input: string | null | undefined, key: string): string | undefined {
  if (!input) return undefined
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(input)
  return match?.[1]?.trim() || undefined
}

/** Extracts a Crew bot identity and avatar from a `task` tool call for organic inline display. */
export function extractToolBot(
  tool: {
    name: string
    text?: string
    input?: string | null
    result?: string | null
  },
  knownBots?: ReadonlyArray<KnownBotAvatar>,
): ToolBotPreview | null {
  if (tool.name !== 'task') return null
  const resultMatch = tool.result ? /^Crew bot (.+?) \(([^)\n]+)\):\n([\s\S]*)$/.exec(tool.result) : null
  const stoppedMatch = !resultMatch && tool.result ? /^Crew bot (.+?)(?: \(([^)\n]+)\))? was stopped\.?(?:\s*Partial report:\n([\s\S]*))?$/.exec(tool.result) : null
  const inputName = readInputField(tool.input, 'name')
  const inputBotId = readInputField(tool.input, 'botId')
  const inputDesc = readInputField(tool.input, 'description')
  const inputModel = readInputField(tool.input, 'model')
  const inputProvider = readInputField(tool.input, 'provider')

  const strippedText = tool.text?.replace(/^Task\s+/i, '').trim() ?? ''
  const [textFirst, ...textRest] = strippedText.split(' · ')
  const rawName = (
    resultMatch?.[1] ??
    stoppedMatch?.[1] ??
    inputName ??
    (textRest.length > 0 ? textFirst : undefined) ??
    inputDesc ??
    strippedText
  )?.trim()

  if (!rawName) return null
  const explicitId = (resultMatch?.[2] ?? stoppedMatch?.[2] ?? inputBotId)?.trim() || undefined
  const matched = resolveKnownBot(explicitId, rawName, knownBots)
  const id = matched?.id ?? explicitId ?? rawName
  const name = matched?.name ?? rawName
  const task = (inputDesc ?? (textRest.length > 0 ? textRest.join(' · ') : strippedText)).trim() || undefined
  const model = inputModel ? (inputProvider ? `${inputProvider}/${inputModel}` : inputModel) : undefined
  const report = (resultMatch?.[3] ?? stoppedMatch?.[3] ?? tool.result ?? '')?.trim() || undefined

  let mission: string | undefined
  if (tool.input) {
    const promptMatch = /^prompt:\n?([\s\S]*)$/m.exec(tool.input)
    if (promptMatch?.[1]) {
      mission = promptMatch[1].replace(/^ {2}/gm, '').trim()
    }
  }

  const base = defaultBotAvatar(id, name)
  const avatar: CrewAvatar = matched?.avatar ? { ...base, ...matched.avatar } : base

  return {
    id,
    name,
    task: task && task !== name ? task : undefined,
    mission,
    model,
    report,
    avatar,
  }
}

