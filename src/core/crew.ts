import { randomInt, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { ensurePrivateDir, writePrivateFile } from '../util/fs.js'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'
import { processIdentity, processIsGone } from '../util/process-identity.js'
import { COLOR_PALETTE_IDS } from './color-palettes.js'
import {
  CREW_AVATAR_ACCESSORIES,
  CREW_AVATAR_EYES,
  CREW_AVATAR_SHAPES,
  defaultBotAvatar,
  formatBotAvatarBadge,
  normalizeBotHandle,
  shuffleBotAvatar,
  slugifyBotHandle,
  type CrewAvatar,
  type CrewAvatarAccessory,
  type CrewAvatarEyes,
  type CrewAvatarShape,
} from './crew-avatars.js'
import { crewFile } from './config/paths.js'
import type { BotAuthor } from './providers/types.js'

export {
  CREW_AVATAR_ACCESSORIES,
  CREW_AVATAR_EYES,
  CREW_AVATAR_SHAPES,
  defaultBotAvatar,
  formatBotAvatarBadge,
  normalizeBotHandle,
  slugifyBotHandle,
  type CrewAvatar,
  type CrewAvatarAccessory,
  type CrewAvatarEyes,
  type CrewAvatarShape,
  type BotAuthor,
}

export const crewAvatarSchema = z.object({
  shape: z.enum(CREW_AVATAR_SHAPES),
  eyes: z.enum(CREW_AVATAR_EYES),
  accessory: z.enum(CREW_AVATAR_ACCESSORIES),
  palette: z.enum(COLOR_PALETTE_IDS),
})

export function resolveBotAvatar(bot: { id: string; name: string; avatar?: Partial<CrewAvatar> }): CrewAvatar {
  const base = defaultBotAvatar(bot.id, bot.name)
  if (!bot.avatar) return base
  const parsed = crewAvatarSchema.safeParse({ ...base, ...bot.avatar })
  return parsed.success ? parsed.data : base
}

const PROCESS_INSTANCE_ID = randomUUID()
const PROCESS_IDENTITY = processIdentity(process.pid)
const MAX_BOT_ASSIGNMENTS = 50
const MAX_BOT_NAME_LENGTH = 120
export const MAX_BOT_HANDLE_LENGTH = 40
export const MAX_BOT_INSTRUCTIONS_LENGTH = 8_000
export const BOT_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/
const MAX_GUIDANCE_LENGTH = 4_000
const MAX_PRIOR_REPORTS = 5
const MAX_PRIOR_CHARS = 8_000

function cleanBotName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').replace(/\)/g, ' ').trim()
}

function nextUniqueHandle(seed: string, taken: Set<string>): string {
  const base = slugifyBotHandle(seed)
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  for (let suffix = 2; ; suffix += 1) {
    const tag = `-${suffix}`
    const candidate = `${base.slice(0, MAX_BOT_HANDLE_LENGTH - tag.length)}${tag}`
    if (!taken.has(candidate)) {
      taken.add(candidate)
      return candidate
    }
  }
}

function validateExplicitHandle(raw: string, taken: Set<string>): string {
  const normalized = normalizeBotHandle(raw)
  if (!BOT_HANDLE_PATTERN.test(normalized)) {
    throw new Error(
      `A mention name must be 1–${MAX_BOT_HANDLE_LENGTH} lowercase letters, numbers, hyphens, or underscores, starting with a letter or number.`,
    )
  }
  if (taken.has(normalized)) {
    throw new Error(`Mention name "@${normalized}" is already used by another bot.`)
  }
  return normalized
}

function cleanBotInstructions(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.length > MAX_BOT_INSTRUCTIONS_LENGTH) {
    throw new Error(`Instructions must be at most ${MAX_BOT_INSTRUCTIONS_LENGTH} characters.`)
  }
  return trimmed
}

/** Deterministic handle resolution for legacy bots that predate persisted handles. */
function resolveBotHandles(bots: CrewBot[]): void {
  const taken = new Set<string>()
  for (const bot of bots) {
    const stored = bot.handle ? normalizeBotHandle(bot.handle) : ''
    if (stored && BOT_HANDLE_PATTERN.test(stored) && !taken.has(stored)) {
      bot.handle = stored
      taken.add(stored)
    } else {
      bot.handle = undefined
    }
  }
  // Assign missing handles deterministically by creation order so adding a new bot
  // never shifts an older bot's derived handle.
  const missing = bots
    .filter((bot) => !bot.handle)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  for (const bot of missing) {
    bot.handle = nextUniqueHandle(bot.name, taken)
  }
}

/** Builds a portable authorship snapshot for transcripts and live events. */
export function toBotAuthor(bot: Pick<CrewBot, 'id' | 'name' | 'handle' | 'avatar'>): BotAuthor {
  return {
    id: bot.id,
    name: bot.name,
    ...(bot.handle ? { handle: bot.handle } : {}),
    avatar: resolveBotAvatar(bot),
  }
}

/** Bounds prior assignment/work reports before injecting them into a prompt. */
export function formatPriorReports(reports: ReadonlyArray<string | undefined>, header: string): string {
  const usable = reports.map((text) => text?.trim() ?? '').filter(Boolean)
  if (usable.length === 0) return ''
  const recent = usable.slice(-MAX_PRIOR_REPORTS)
  const kept: string[] = []
  let total = 0
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const entry = recent[index]!
    const cost = entry.length + (kept.length > 0 ? 2 : 0)
    if (kept.length > 0 && total + cost > MAX_PRIOR_CHARS) break
    const clipped = entry.length > MAX_PRIOR_CHARS ? `${entry.slice(0, MAX_PRIOR_CHARS - 1)}…` : entry
    kept.unshift(clipped)
    total += clipped.length + (kept.length > 1 ? 2 : 0)
  }
  return `${header}\n${kept.join('\n\n')}`
}

function randomBotAvatar(current?: CrewAvatar): CrewAvatar {
  return shuffleBotAvatar(current, (length) => randomInt(length))
}

const assignmentSchema = z.object({
  id: z.string(), sessionId: z.string(), mission: z.string(), model: z.string(),
  provider: z.string().optional(),
  state: z.enum(['running', 'completed', 'failed', 'interrupted']),
  startedAt: z.number(), finishedAt: z.number().optional(), report: z.string().optional(),
  processId: z.number().int().positive().optional(),
  instanceId: z.string().optional(),
  processIdentity: z.string().optional(),
  stopRequestedAt: z.number().optional(),
  guidance: z.array(z.object({ id: z.string(), text: z.string(), at: z.number(), appliedAt: z.number().optional() })).optional(),
})
const botSchema = z.object({
  id: z.string(),
  name: z.string(),
  handle: z.string().optional(),
  instructions: z.string().optional(),
  createdAt: z.number(),
  avatar: crewAvatarSchema.optional(),
  assignments: z.array(assignmentSchema),
})
export type CrewAssignment = z.infer<typeof assignmentSchema>
export type CrewBot = z.infer<typeof botSchema>

function isDeadPid(pid: number, instanceId: string | undefined, identity: string | undefined, forStartupRecover: boolean): boolean {
  if (forStartupRecover && instanceId && pid === process.pid && instanceId !== PROCESS_INSTANCE_ID) {
    return true
  }
  return processIsGone(pid, identity)
}

function markDeadProcesses(bots: CrewBot[], forStartupRecover = false): boolean {
  let changed = false
  for (const bot of bots) for (const assignment of bot.assignments) {
    if (assignment.state !== 'running' || assignment.processId === undefined) continue
    if (!isDeadPid(assignment.processId, assignment.instanceId, assignment.processIdentity, forStartupRecover)) continue
    assignment.state = 'interrupted'
    assignment.report = 'The process running this assignment stopped before it finished.'
    changed = true
  }
  return changed
}

/** One store is shared by every surface and by the agent that starts a bot. */
export class CrewStore {
  private tail: Promise<void> = Promise.resolve()
  private cached: { mtimeMs: number; size: number; data: CrewBot[] } | null = null

  constructor(private readonly file = crewFile()) {}

  private readRaw(bypassCache = false): CrewBot[] | null {
    let stat: { mtimeMs: number; size: number }
    try {
      stat = statSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cached = null
        return null
      }
      throw error
    }
    if (!bypassCache && this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) {
      return structuredClone(this.cached.data)
    }
    let content: string
    try {
      content = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cached = null
        return null
      }
      throw error
    }
    try {
      const parsed = z.array(botSchema).parse(JSON.parse(content))
      this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, data: parsed }
      return structuredClone(parsed)
    } catch (error) {
      throw new Error(`Could not read crew: ${errorMessage(error)}`)
    }
  }

  list(): CrewBot[] {
    const bots = this.readRaw()
    if (!bots) return []
    markDeadProcesses(bots)
    resolveBotHandles(bots)
    for (const bot of bots) bot.avatar = resolveBotAvatar(bot)
    return bots.sort((a, b) => {
      const left = a.assignments.at(-1)
      const right = b.assignments.at(-1)
      return (
        Number(right?.state === 'running') - Number(left?.state === 'running') ||
        (right?.startedAt ?? 0) - (left?.startedAt ?? 0) ||
        b.createdAt - a.createdAt
      )
    })
  }

  get(id: string): CrewBot | undefined {
    const trimmed = id.trim()
    if (!trimmed) return undefined
    return this.list().find((bot) => bot.id === trimmed)
  }

  findByHandle(rawHandle: string): CrewBot | undefined {
    const normalized = normalizeBotHandle(rawHandle)
    if (!normalized) return undefined
    return this.list().find((bot) => bot.handle?.toLowerCase() === normalized)
  }

  /** Persist dead-process recovery so an OS PID reuse cannot resurrect an abandoned run. */
  async recover(): Promise<void> {
    const bots = this.readRaw(true)
    if (!bots || !markDeadProcesses(bots, true)) return
    await this.change((current) => {
      markDeadProcesses(current, true)
    })
  }

  private async change<T>(fn: (bots: CrewBot[]) => T): Promise<T> {
    const previous = this.tail
    let done!: () => void
    this.tail = new Promise<void>((resolve) => { done = resolve })
    await previous
    let release: (() => Promise<void>) | undefined
    try {
      ensurePrivateDir(dirname(this.file))
      release = await lockfile.lock(this.file, {
        realpath: false, stale: 10_000,
        retries: { retries: 15, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true },
        onCompromised: (error) => logWarn(`lost the lock on crew: ${errorMessage(error)}`),
      })
      const raw = this.readRaw(true) ?? []
      markDeadProcesses(raw)
      resolveBotHandles(raw)
      for (const bot of raw) bot.avatar = resolveBotAvatar(bot)
      const result = fn(raw)
      this.cached = null
      await writePrivateFile(this.file, `${JSON.stringify(raw, null, 2)}\n`)
      return result
    } finally {
      try { await release?.() } finally { done() }
    }
  }

  async start(input: { name: string; mission: string; model: string; provider?: string; sessionId: string; botId?: string }): Promise<{ bot: CrewBot; assignment: CrewAssignment }> {
    return this.change((bots) => {
      const name = cleanBotName(input.name)
      if (!name || !input.mission.trim()) throw new Error('A bot needs a name and a mission.')
      if (name.length > MAX_BOT_NAME_LENGTH) throw new Error(`A bot name must be at most ${MAX_BOT_NAME_LENGTH} characters.`)
      const requestedId = input.botId?.trim()
      if (input.botId !== undefined && !requestedId) throw new Error('No bot has that id.')
      let bot = requestedId ? bots.find((entry) => entry.id === requestedId) : undefined
      if (requestedId && !bot) throw new Error('No bot has that id.')
      if (bot?.assignments.some((entry) => entry.state === 'running')) throw new Error('This bot is already working.')
      if (!bot) {
        const id = randomUUID()
        const taken = new Set(bots.map((entry) => entry.handle).filter((h): h is string => Boolean(h)))
        const handle = nextUniqueHandle(name, taken)
        bot = { id, name, handle, createdAt: Date.now(), avatar: defaultBotAvatar(id, name), assignments: [] }
        bots.push(bot)
      }
      const assignment: CrewAssignment = {
        id: randomUUID(), sessionId: input.sessionId, mission: input.mission,
        model: input.model, provider: input.provider, state: 'running', startedAt: Date.now(), processId: process.pid, instanceId: PROCESS_INSTANCE_ID, processIdentity: PROCESS_IDENTITY,
      }
      bot.assignments.push(assignment)
      if (bot.assignments.length > MAX_BOT_ASSIGNMENTS) {
        const running = bot.assignments.filter((entry) => entry.state === 'running')
        const finished = bot.assignments.filter((entry) => entry.state !== 'running')
        bot.assignments = [...finished.slice(-(MAX_BOT_ASSIGNMENTS - running.length)), ...running]
      }
      return { bot, assignment }
    })
  }

  async finish(botId: string, assignmentId: string, state: 'completed' | 'failed' | 'interrupted', report: string, appliedGuidance: string[] = []): Promise<'completed' | 'failed' | 'interrupted'> {
    return this.change((bots) => {
      const assignment = bots.find((bot) => bot.id === botId)?.assignments.find((entry) => entry.id === assignmentId)
      if (assignment?.state !== 'running') throw new Error('The running assignment was not found.')
      assignment.state = assignment.stopRequestedAt ? 'interrupted' : state
      assignment.report = report
      assignment.finishedAt = Date.now()
      for (const guidance of assignment.guidance ?? []) if (appliedGuidance.includes(guidance.id)) guidance.appliedAt = assignment.finishedAt
      return assignment.state
    })
  }

  async guide(id: string, text: string): Promise<void> {
    await this.change((bots) => {
      const bot = bots.find((entry) => entry.id === id)
      if (!bot) throw new Error('No bot has that id.')
      const assignment = bot.assignments.find((entry) => entry.state === 'running')
      if (!assignment || assignment.stopRequestedAt) throw new Error('This bot is not accepting guidance.')
      const words = text.trim()
      if (!words) throw new Error('Guidance cannot be empty.')
      if (words.length > MAX_GUIDANCE_LENGTH) throw new Error(`Guidance must be at most ${MAX_GUIDANCE_LENGTH} characters.`)
      if (!assignment.guidance) assignment.guidance = []
      assignment.guidance.push({ id: randomUUID(), text: words, at: Date.now() })
    })
  }

  /** Request a stop in the process running this bot; the owner marks its outcome. */
  async stop(id: string): Promise<void> {
    await this.change((bots) => {
      const bot = bots.find((entry) => entry.id === id)
      if (!bot) throw new Error('No bot has that id.')
      const assignment = bot.assignments.find((entry) => entry.state === 'running')
      if (!assignment) throw new Error('This bot is not working.')
      assignment.stopRequestedAt ??= Date.now()
    })
  }

  async create(input: {
    name: string
    handle?: string
    instructions?: string
    avatar?: Partial<CrewAvatar>
  }): Promise<CrewBot> {
    return this.change((bots) => {
      const name = cleanBotName(input.name)
      if (!name) throw new Error('A bot needs a name.')
      if (name.length > MAX_BOT_NAME_LENGTH) throw new Error(`A bot name must be at most ${MAX_BOT_NAME_LENGTH} characters.`)
      const taken = new Set(bots.map((entry) => entry.handle).filter((h): h is string => Boolean(h)))
      const handle = input.handle !== undefined
        ? validateExplicitHandle(input.handle, taken)
        : nextUniqueHandle(name, taken)
      const instructions = cleanBotInstructions(input.instructions)
      const id = randomUUID()
      const baseAvatar = defaultBotAvatar(id, name)
      let avatar = baseAvatar
      if (input.avatar) {
        const parsed = crewAvatarSchema.safeParse({ ...baseAvatar, ...input.avatar })
        if (!parsed.success) {
          throw new Error(
            `Invalid avatar. Shapes: ${CREW_AVATAR_SHAPES.join(', ')}. Eyes: ${CREW_AVATAR_EYES.join(', ')}. Accessories: ${CREW_AVATAR_ACCESSORIES.join(', ')}. Palettes: ${COLOR_PALETTE_IDS.join(', ')}.`,
          )
        }
        avatar = parsed.data
      }
      const bot: CrewBot = {
        id,
        name,
        handle,
        ...(instructions ? { instructions } : {}),
        createdAt: Date.now(),
        avatar,
        assignments: [],
      }
      bots.push(bot)
      return bot
    })
  }

  async updateProfile(
    id: string,
    patch: { name?: string; handle?: string; instructions?: string | null },
  ): Promise<CrewBot> {
    return this.change((bots) => {
      const bot = bots.find((entry) => entry.id === id)
      if (!bot) throw new Error('No bot has that id.')
      if (patch.name !== undefined) {
        const clean = cleanBotName(patch.name)
        if (!clean) throw new Error('A bot needs a name.')
        if (clean.length > MAX_BOT_NAME_LENGTH) throw new Error(`A bot name must be at most ${MAX_BOT_NAME_LENGTH} characters.`)
        bot.name = clean
      }
      if (patch.handle !== undefined) {
        const taken = new Set(
          bots
            .filter((entry) => entry.id !== id)
            .map((entry) => entry.handle)
            .filter((h): h is string => Boolean(h)),
        )
        bot.handle = validateExplicitHandle(patch.handle, taken)
      }
      if (patch.instructions !== undefined) {
        const instructions = cleanBotInstructions(patch.instructions)
        if (instructions) bot.instructions = instructions
        else delete bot.instructions
      }
      return bot
    })
  }

  async rename(id: string, name: string): Promise<CrewBot> {
    return this.updateProfile(id, { name })
  }

  async remove(id: string): Promise<CrewBot> {
    return this.change((bots) => {
      const index = bots.findIndex((entry) => entry.id === id)
      if (index === -1) throw new Error('No bot has that id.')
      const bot = bots[index]!
      if (bot.assignments.some((entry) => entry.state === 'running')) {
        throw new Error('This bot is still working — stop it before removing.')
      }
      bots.splice(index, 1)
      return bot
    })
  }

  async updateAvatar(id: string, patch: Partial<CrewAvatar> | 'shuffle'): Promise<CrewBot> {
    return this.change((bots) => {
      const bot = bots.find((entry) => entry.id === id)
      if (!bot) throw new Error('No bot has that id.')
      const current = resolveBotAvatar(bot)
      if (patch === 'shuffle') {
        bot.avatar = randomBotAvatar(current)
        return bot
      }
      const next = {
        shape: patch.shape ?? current.shape,
        eyes: patch.eyes ?? current.eyes,
        accessory: patch.accessory ?? current.accessory,
        palette: patch.palette ?? current.palette,
      }
      const parsed = crewAvatarSchema.safeParse(next)
      if (!parsed.success) {
        throw new Error(
          `Invalid avatar. Shapes: ${CREW_AVATAR_SHAPES.join(', ')}. Eyes: ${CREW_AVATAR_EYES.join(', ')}. Accessories: ${CREW_AVATAR_ACCESSORIES.join(', ')}. Palettes: ${COLOR_PALETTE_IDS.join(', ')}.`,
        )
      }
      bot.avatar = parsed.data
      return bot
    })
  }
}
