import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { ensurePrivateDir, writePrivateFile } from '../util/fs.js'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'
import { processIdentity, processIsGone } from '../util/process-identity.js'
import { delegatedWorkFile } from './config/paths.js'
import { nextRunAt, type RoutineTarget, type RoutineWhen } from './routines.js'

const PROCESS_INSTANCE_ID = randomUUID()
const PROCESS_IDENTITY = processIdentity(process.pid)
const MAX_WORK_RUNS = 50

function isDeadRunPid(pid: number, instanceId: string | undefined, identity: string | undefined, forStartupRecover: boolean): boolean {
  if (forStartupRecover && instanceId && pid === process.pid && instanceId !== PROCESS_INSTANCE_ID) {
    return true
  }
  return processIsGone(pid, identity)
}

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every'), minutes: z.number().positive().finite() }),
  z.object({ kind: z.literal('at'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), days: z.array(z.number().int().min(0).max(6)).min(1).optional(), dayOfMonth: z.array(z.number().int().min(1).max(31)).min(1).optional(), month: z.array(z.number().int().min(1).max(12)).min(1).optional() })
    .refine((when) => !when.days || !when.dayOfMonth, 'Choose weekdays or dates, not both.'),
])
const targetSchema = z.union([
  z.object({ gateway: z.enum(['telegram', 'discord', 'web']), chatId: z.string().min(1) }),
  z.object({ gateway: z.literal('none') }),
])
const runSchema = z.object({
  id: z.string(), startedAt: z.number(), finishedAt: z.number().optional(), sessionId: z.string().optional(),
  result: z.enum(['running', 'completed', 'failed', 'interrupted', 'cancelled']),
  report: z.string().optional(), failure: z.string().optional(), processId: z.number().int().positive(),
  instanceId: z.string().optional(),
  processIdentity: z.string().optional(),
  deliveryError: z.string().optional(),
})
const workSchema = z.object({
  id: z.string(), name: z.string().min(1), objective: z.string().min(1),
  schedule: scheduleSchema.optional(), target: targetSchema, allow: z.array(z.string()),
  project: z.string().optional(), originSessionId: z.string(), createdAt: z.number(),
  state: z.enum(['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'interrupted', 'cancelled']),
  pauseAfterRun: z.boolean().optional(), nextAt: z.number().optional(), runs: z.array(runSchema),
})

export type DelegatedWork = z.infer<typeof workSchema>
export type DelegatedRun = z.infer<typeof runSchema>
interface NewDelegatedWork {
  name: string
  objective: string
  schedule?: RoutineWhen
  target: RoutineTarget
  allow: string[]
  project?: string
  originSessionId: string
}

/** The install's one record of delegated objectives, shared by every surface. */
export class DelegatedWorkStore {
  private tail: Promise<void> = Promise.resolve()
  private cached: { mtimeMs: number; size: number; data: DelegatedWork[] } | null = null
  constructor(private readonly file = delegatedWorkFile()) {}

  private readAll(bypassCache = false): DelegatedWork[] {
    let stat: { mtimeMs: number; size: number }
    try { stat = statSync(this.file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.cached = null; return [] }
      throw error
    }
    if (!bypassCache && this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) {
      return structuredClone(this.cached.data)
    }
    let raw: string
    try { raw = readFileSync(this.file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.cached = null; return [] }
      throw error
    }
    try {
      const parsed = z.array(workSchema).parse(JSON.parse(raw))
      this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, data: parsed }
      return structuredClone(parsed)
    } catch (error) { throw new Error(`Could not read delegated work: ${errorMessage(error)}`) }
  }

  list(): DelegatedWork[] {
    return this.readAll()
  }

  private async change<T>(fn: (items: DelegatedWork[]) => T): Promise<T> {
    const previous = this.tail
    let unlock!: () => void
    this.tail = new Promise<void>((resolve) => { unlock = resolve })
    await previous
    let release: (() => Promise<void>) | undefined
    try {
      ensurePrivateDir(dirname(this.file))
      release = await lockfile.lock(this.file, {
        realpath: false, stale: 10_000,
        retries: { retries: 15, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true },
        onCompromised: (error) => logWarn(`lost the lock on delegated work: ${errorMessage(error)}`),
      })
      const items = this.readAll(true)
      const result = fn(items)
      this.cached = null
      await writePrivateFile(this.file, `${JSON.stringify(items, null, 2)}\n`)
      return result
    } finally {
      try { await release?.() } finally { unlock() }
    }
  }

  async create(input: NewDelegatedWork): Promise<DelegatedWork> {
    return this.change((items) => {
      const item = workSchema.parse({ ...input, name: input.name.trim(), objective: input.objective.trim(), id: randomUUID(), createdAt: Date.now(), state: 'queued', runs: [] })
      items.push(item)
      return item
    })
  }

  /** Claims a due execution while holding the cross-process lock. */
  async claim(id: string, now: number): Promise<{ work: DelegatedWork; run: DelegatedRun } | null> {
    return this.change((items) => {
      const work = items.find((item) => item.id === id)
      if (!work || !(work.state === 'queued' || (work.state === 'waiting' && work.nextAt !== undefined && work.nextAt <= now))) return null
      const run: DelegatedRun = { id: randomUUID(), startedAt: now, result: 'running', processId: process.pid, instanceId: PROCESS_INSTANCE_ID, processIdentity: PROCESS_IDENTITY }
      work.runs.push(run)
      if (work.runs.length > MAX_WORK_RUNS) {
        const running = work.runs.filter((entry) => entry.result === 'running')
        const finished = work.runs.filter((entry) => entry.result !== 'running')
        work.runs = [...finished.slice(-(MAX_WORK_RUNS - running.length)), ...running]
      }
      work.state = 'running'
      delete work.nextAt
      return { work, run }
    })
  }

  async finish(id: string, runId: string, result: { sessionId?: string; report: string; failure?: string }, now: number): Promise<DelegatedWork> {
    return this.change((items) => {
      const work = items.find((item) => item.id === id)
      const run = work?.runs.find((entry) => entry.id === runId)
      if (!work || !run || run.result !== 'running') throw new Error('The running work was not found.')
      run.finishedAt = now
      run.sessionId = result.sessionId
      run.report = result.report
      if (result.failure) run.failure = result.failure
      run.result = work.state === 'cancelled' ? 'cancelled' : result.failure ? 'failed' : 'completed'
      if (work.state === 'cancelled') return work
      if (work.pauseAfterRun) { work.state = 'paused'; delete work.pauseAfterRun }
      else if (work.schedule) { work.state = 'waiting'; work.nextAt = nextRunAt(work.schedule, new Date(now)).getTime() }
      else work.state = result.failure ? 'failed' : 'completed'
      return work
    })
  }

  async control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<DelegatedWork> {
    return this.change((items) => {
      const work = items.find((item) => item.id === id)
      if (!work) throw new Error('No delegated work has that id.')
      if (action === 'cancel') {
        if (['cancelled', 'completed'].includes(work.state)) throw new Error('This work is already finished.')
        work.state = 'cancelled'
        delete work.nextAt
        delete work.pauseAfterRun
      } else if (action === 'pause') {
        if (work.state === 'running') work.pauseAfterRun = true
        else if (work.state === 'queued' || work.state === 'waiting') { work.state = 'paused'; delete work.nextAt }
        else throw new Error('This work cannot be paused.')
      } else {
        if (!['paused', 'failed', 'interrupted'].includes(work.state)) throw new Error('This work cannot be resumed.')
        work.state = 'queued'
        delete work.pauseAfterRun
      }
      return work
    })
  }

  async edit(id: string, patch: { objective?: string; schedule?: RoutineWhen | null }, now = Date.now()): Promise<DelegatedWork> {
    return this.change((items) => {
      const work = items.find((item) => item.id === id)
      if (!work) throw new Error('No delegated work has that id.')
      if (work.state === 'running') throw new Error('Wait for the current run to finish before editing this work.')
      if (work.state === 'completed' || work.state === 'cancelled') throw new Error('Finished work cannot be edited.')
      if (patch.objective !== undefined) {
        if (!patch.objective.trim()) throw new Error('An objective cannot be empty.')
        work.objective = patch.objective.trim()
      }
      if (patch.schedule !== undefined) {
        if (patch.schedule === null) delete work.schedule
        else work.schedule = scheduleSchema.parse(patch.schedule)
        if (work.state === 'waiting') {
          if (work.schedule) work.nextAt = nextRunAt(work.schedule, new Date(now)).getTime()
          else { work.state = 'queued'; delete work.nextAt }
        }
      }
      return work
    })
  }

  /** Recover abandoned runs and skip recurring times missed while the daemon was down. */
  async recover(now: number): Promise<void> {
    await this.change((items) => {
      for (const work of items) {
        if (work.state === 'waiting' && work.schedule && (work.nextAt ?? now) < now) {
          work.nextAt = nextRunAt(work.schedule, new Date(now)).getTime()
        }
        if (work.state !== 'running' && work.state !== 'cancelled') continue
        const run = work.runs.findLast((entry) => entry.result === 'running')
        if (!run) {
          if (work.state === 'cancelled') continue
          if (work.pauseAfterRun) { work.state = 'paused'; delete work.pauseAfterRun }
          else if (work.schedule) { work.state = 'waiting'; work.nextAt = nextRunAt(work.schedule, new Date(now)).getTime() }
          else work.state = 'interrupted'
          continue
        }
        if (!isDeadRunPid(run.processId, run.instanceId, run.processIdentity, true)) continue
        run.result = work.state === 'cancelled' ? 'cancelled' : 'interrupted'
        run.finishedAt = now
        run.report = 'The process running this work stopped before it finished.'
        if (work.state === 'cancelled') continue
        if (work.pauseAfterRun) { work.state = 'paused'; delete work.pauseAfterRun }
        else if (work.schedule) { work.state = 'waiting'; work.nextAt = nextRunAt(work.schedule, new Date(now)).getTime() }
        else work.state = 'interrupted'
      }
    })
  }

  async deliveryFailed(id: string, runId: string, error: string): Promise<void> {
    await this.change((items) => {
      const run = items.find((item) => item.id === id)?.runs.find((entry) => entry.id === runId)
      if (!run) throw new Error('The work run was not found.')
      run.deliveryError = error
    })
  }
}
