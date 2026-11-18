import { randomInt, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { ensurePrivateDir, writePrivateFile } from '../util/fs.js'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'
import { COLOR_PALETTE_IDS, type ColorPaletteId } from './color-palettes.js'
import {
  CREW_AVATAR_ACCESSORIES,
  CREW_AVATAR_EYES,
  CREW_AVATAR_SHAPES,
  defaultBotAvatar,
  formatBotAvatarBadge,
  type CrewAvatar,
  type CrewAvatarAccessory,
  type CrewAvatarEyes,
  type CrewAvatarShape,
} from './crew-avatars.js'
import { crewFile } from './config/paths.js'

export {
  CREW_AVATAR_ACCESSORIES,
  CREW_AVATAR_EYES,
  CREW_AVATAR_SHAPES,
  defaultBotAvatar,
  formatBotAvatarBadge,
  type CrewAvatar,
  type CrewAvatarAccessory,
  type CrewAvatarEyes,
  type CrewAvatarShape,
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

export function randomBotAvatar(current?: CrewAvatar): CrewAvatar {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next: CrewAvatar = {
      shape: CREW_AVATAR_SHAPES[randomInt(CREW_AVATAR_SHAPES.length)]!,
      eyes: CREW_AVATAR_EYES[randomInt(CREW_AVATAR_EYES.length)]!,
      accessory: CREW_AVATAR_ACCESSORIES[randomInt(CREW_AVATAR_ACCESSORIES.length)]!,
      palette: COLOR_PALETTE_IDS[randomInt(COLOR_PALETTE_IDS.length)] as ColorPaletteId,
    }
    if (!current || next.shape !== current.shape || next.eyes !== current.eyes || next.palette !== current.palette) {
      return next
    }
  }
  return defaultBotAvatar(randomUUID())
}

const assignmentSchema = z.object({
  id: z.string(), sessionId: z.string(), mission: z.string(), model: z.string(),
  provider: z.string().optional(),
  state: z.enum(['running', 'completed', 'failed', 'interrupted']),
  startedAt: z.number(), finishedAt: z.number().optional(), report: z.string().optional(),
  processId: z.number().int().positive().optional(),
  stopRequestedAt: z.number().optional(),
  guidance: z.array(z.object({ id: z.string(), text: z.string(), at: z.number(), appliedAt: z.number().optional() })).optional(),
})
const botSchema = z.object({
  id: z.string(), name: z.string(), createdAt: z.number(),
  avatar: crewAvatarSchema.optional(),
  assignments: z.array(assignmentSchema),
})
export type CrewAssignment = z.infer<typeof assignmentSchema>
export type CrewBot = z.infer<typeof botSchema>

function markDeadProcesses(bots: CrewBot[]): boolean {
  let changed = false
  for (const bot of bots) for (const assignment of bot.assignments) {
    if (assignment.state !== 'running' || assignment.processId === undefined) continue
    try { process.kill(assignment.processId, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      assignment.state = 'interrupted'
      assignment.report = 'The process running this assignment stopped before it finished.'
      changed = true
    }
  }
  return changed
}

/** One store is shared by every surface and by the agent that starts a bot. */
export class CrewStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly file = crewFile()) {}

  private readRaw(): CrewBot[] | null {
    let content: string
    try {
      content = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      return z.array(botSchema).parse(JSON.parse(content))
    } catch (error) {
      throw new Error(`Could not read crew: ${errorMessage(error)}`)
    }
  }

  list(): CrewBot[] {
    const bots = this.readRaw()
    if (!bots) return []
    markDeadProcesses(bots)
    for (const bot of bots) bot.avatar = resolveBotAvatar(bot)
    return bots.sort((a, b) => {
      const left = a.assignments.at(-1)
      const right = b.assignments.at(-1)
      return Number(right?.state === 'running') - Number(left?.state === 'running') || (right?.startedAt ?? 0) - (left?.startedAt ?? 0)
    })
  }

  /** Persist dead-process recovery so an OS PID reuse cannot resurrect an abandoned run. */
  async recover(): Promise<void> {
    const bots = this.readRaw()
    if (!bots || !markDeadProcesses(bots)) return
    await this.change(() => undefined)
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
      const bots = this.list()
      const result = fn(bots)
      await writePrivateFile(this.file, `${JSON.stringify(bots, null, 2)}\n`)
      return result
    } finally {
      try { await release?.() } finally { done() }
    }
  }

  async start(input: { name: string; mission: string; model: string; provider?: string; sessionId: string; botId?: string }): Promise<{ bot: CrewBot; assignment: CrewAssignment }> {
    return this.change((bots) => {
      const name = input.name.trim()
      if (!name || !input.mission.trim()) throw new Error('A bot needs a name and a mission.')
      let bot = input.botId ? bots.find((entry) => entry.id === input.botId) : undefined
      if (input.botId && !bot) throw new Error('No bot has that id.')
      if (bot?.assignments.some((entry) => entry.state === 'running')) throw new Error('This bot is already working.')
      if (!bot) {
        const id = randomUUID()
        bot = { id, name, createdAt: Date.now(), avatar: defaultBotAvatar(id, name), assignments: [] }
        bots.push(bot)
      }
      const assignment: CrewAssignment = {
        id: randomUUID(), sessionId: input.sessionId, mission: input.mission,
        model: input.model, provider: input.provider, state: 'running', startedAt: Date.now(), processId: process.pid,
      }
      bot.assignments.push(assignment)
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

  async rename(id: string, name: string): Promise<CrewBot> {
    return this.change((bots) => {
      const bot = bots.find((entry) => entry.id === id)
      if (!bot) throw new Error('No bot has that id.')
      if (!name.trim()) throw new Error('A bot needs a name.')
      bot.name = name.trim()
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
