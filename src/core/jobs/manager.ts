import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import { ensurePrivateDir, writePrivateFile } from '../../util/fs.js'
import { jobDir, jobLogFile, jobMetaFile, jobsDir } from '../config/paths.js'
import type {
  JobFacts,
  JobInfo,
  JobMeta,
  JobNotify,
  JobStartInput,
  JobStartResult,
  JobState,
} from './types.js'

/** The output kept in memory for a status read; the full log is on disk. */
const MAX_LINES = 120
const MAX_LINE_LENGTH = 400
/** How many finished jobs stay in memory for `/jobs`; older ones are on disk only. */
const KEEP_FINISHED = 50
/** How much of a log is read back from disk on startup, to restore a job's tail. */
const TAIL_BYTES = 64 * 1024

/** A job as the manager holds it: the stored meta plus what only this process knows. */
interface JobRecord extends JobMeta {
  logPath: string
  /** The tail of the output, oldest first. */
  lines: string[]
  /** A line still arriving, before its newline. */
  partial: string
  child: ChildProcess | null
  /** Resolves once the child has exited or failed; `close()` waits on it. */
  exited: Promise<void>
  /** A kill was asked for, so the exit is `killed` and not an error. */
  killing: boolean
  /** The process actually started; a spawn that threw synchronously did not. */
  spawned: boolean
}

/**
 * The background jobs of one Milo process.
 *
 * A job is a shell command left running behind a conversation: `shell_command`
 * with `background: true` hands it here and returns at once, so the turn is not
 * frozen waiting on a download. The manager owns the child processes, keeps the
 * tail of each one's output in memory and its full log on disk, and tells its
 * listeners when a job's state moves — the surface's indicator on every change,
 * the notifier on the settled one.
 *
 * A job lives as long as this process, like the browser and the embedding engine:
 * `close()` stops what is running on the way out. What it wrote stays under
 * `~/.milo/jobs/<id>/`, and a job a dead process left saying `running` is read
 * back as `interrupted` on the next start rather than pretended alive.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>()
  private seq = 0
  private readonly max: number
  private closing = false
  private readonly changeListeners = new Set<() => void>()
  private readonly settledListeners = new Set<(job: JobInfo) => void>()
  /** State writes still in flight, so `close()` can drain them before exiting. */
  private readonly pendingMeta = new Set<Promise<void>>()

  constructor(options: { max?: number } = {}) {
    this.max = Math.max(1, options.max ?? 8)
    this.load()
  }

  /** How many jobs may run at once. */
  get limit(): number {
    return this.max
  }

  /**
   * Starts a command in the background. Refused when the cap is reached or the
   * process could not be spawned — a caller gets a reason rather than a job id
   * that leads nowhere.
   */
  start(input: JobStartInput): JobStartResult {
    if (this.runningCount() >= this.max) {
      return { ok: false, error: `Already running ${this.max} background job(s); stop one with job_kill first.` }
    }
    this.seq += 1
    const id = `job_${this.seq}`
    ensurePrivateDir(jobDir(id))
    const job: JobRecord = {
      id,
      command: input.command,
      cwd: input.cwd,
      notify: input.notify ?? 'auto',
      origin: input.origin,
      state: 'running',
      startedAt: Date.now(),
      logPath: jobLogFile(id),
      lines: [],
      partial: '',
      child: null,
      exited: Promise.resolve(),
      killing: false,
      spawned: false,
    }
    this.jobs.set(id, job)

    let child: ChildProcess
    try {
      child = spawn('/bin/sh', ['-c', input.command], {
        cwd: input.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.jobs.delete(id)
      return { ok: false, error: `Could not start the job: ${errorMessage(error)}` }
    }

    // Resolved when the child is gone, so `close()` can wait for it rather than
    // let a state write race the process shutting down.
    let markExited: () => void = () => undefined
    job.exited = new Promise<void>((resolve) => {
      markExited = resolve
    })

    job.child = child
    job.spawned = true
    this.trackMeta(job)
    child.stdout?.on('data', (chunk: Buffer) => this.capture(job, chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.capture(job, chunk))
    child.on('error', (error) => {
      this.pushLine(job, `could not run: ${errorMessage(error)}`)
      this.settle(job, 'error', undefined)
      markExited()
    })
    child.on('exit', (code) => {
      const state: JobState = job.killing ? 'killed' : code === 0 ? 'done' : 'error'
      this.settle(job, state, code ?? undefined)
      markExited()
    })

    this.prune()
    this.emitChange()
    return { ok: true, job: this.info(job) }
  }

  /** Every job this process knows, newest first. */
  list(): JobInfo[] {
    return [...this.jobs.values()]
      .map((job) => this.info(job))
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Live state for the system prompt: the jobs still running. */
  facts(): JobFacts {
    return { jobs: this.list() }
  }

  get(id: string): JobInfo | null {
    const job = this.jobs.get(id)
    return job ? this.info(job) : null
  }

  /** Stops a running job. False when there is no such job, or it already ended. */
  kill(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job || job.state !== 'running') return false
    job.killing = true
    this.terminate(job)
    return true
  }

  /** Called when a job's state moves — for a surface's indicator. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  /** Called once when a job ends — for the completion notification. */
  onSettled(listener: (job: JobInfo) => void): () => void {
    this.settledListeners.add(listener)
    return () => this.settledListeners.delete(listener)
  }

  /** Stops everything still running and writes the last state. The way out. */
  async close(): Promise<void> {
    this.closing = true
    const running = [...this.jobs.values()].filter((job) => job.state === 'running')
    for (const job of running) {
      job.killing = true
      this.terminate(job)
    }
    // Wait for the children to actually go, then for the state writes they
    // triggered — otherwise the last write can race the process out.
    await Promise.allSettled(running.map((job) => job.exited))
    await Promise.allSettled([...this.pendingMeta])
  }

  private runningCount(): number {
    let count = 0
    for (const job of this.jobs.values()) if (job.state === 'running') count += 1
    return count
  }

  private capture(job: JobRecord, chunk: Buffer): void {
    const text = chunk.toString()
    try {
      appendFileSync(job.logPath, text)
    } catch (error) {
      logWarn(`could not write the log of ${job.id}: ${errorMessage(error)}`)
    }
    // A progress bar updates with `\r` and never a newline; both end a line for
    // the readout, so the tail shows progress instead of one endless line.
    job.partial += text.replace(/\r/g, '\n')
    let index = job.partial.indexOf('\n')
    while (index >= 0) {
      this.pushLine(job, job.partial.slice(0, index))
      job.partial = job.partial.slice(index + 1)
      index = job.partial.indexOf('\n')
    }
    if (job.partial.length >= MAX_LINE_LENGTH) {
      this.pushLine(job, job.partial)
      job.partial = ''
    }
    this.emitChange()
  }

  private pushLine(job: JobRecord, raw: string): void {
    const line = raw.length > MAX_LINE_LENGTH ? raw.slice(0, MAX_LINE_LENGTH) : raw
    if (line.trim().length === 0) return
    job.lines.push(line)
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES)
  }

  private settle(job: JobRecord, state: JobState, exitCode?: number): void {
    if (job.state !== 'running') return
    if (job.partial.trim().length > 0) {
      this.pushLine(job, job.partial)
      job.partial = ''
    }
    job.state = state
    job.exitCode = exitCode
    job.endedAt = Date.now()
    job.child = null
    this.trackMeta(job)
    this.emitChange()
    if (job.spawned) this.notify(job)
  }

  private terminate(job: JobRecord): void {
    const child = job.child
    if (!child || child.exitCode !== null) {
      this.settle(job, 'killed', undefined)
      return
    }
    child.kill('SIGTERM')
    const force = setTimeout(() => {
      if (job.state === 'running') child.kill('SIGKILL')
    }, 5_000)
    force.unref?.()
  }

  private notify(job: JobRecord): void {
    if (this.closing) return
    const info = this.info(job)
    for (const listener of this.settledListeners) {
      try {
        listener(info)
      } catch (error) {
        logWarn(`job listener failed: ${errorMessage(error)}`)
      }
    }
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch (error) {
        logWarn(`job listener failed: ${errorMessage(error)}`)
      }
    }
  }

  private info(job: JobRecord): JobInfo {
    return {
      id: job.id,
      command: job.command,
      cwd: job.cwd,
      notify: job.notify,
      origin: job.origin,
      state: job.state,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      exitCode: job.exitCode,
      logPath: job.logPath,
      lines: [...job.lines],
    }
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((job) => job.state !== 'running')
    if (finished.length <= KEEP_FINISHED) return
    finished.sort((a, b) => a.startedAt - b.startedAt)
    for (const job of finished.slice(0, finished.length - KEEP_FINISHED)) {
      this.jobs.delete(job.id)
    }
  }

  private meta(job: JobMeta): JobMeta {
    return {
      id: job.id,
      command: job.command,
      cwd: job.cwd,
      notify: job.notify,
      origin: job.origin,
      state: job.state,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      exitCode: job.exitCode,
    }
  }

  private async writeMeta(job: JobMeta): Promise<void> {
    await writePrivateFile(jobMetaFile(job.id), JSON.stringify(this.meta(job)))
  }

  /** Writes a job's state, tracking the write so `close()` can wait for it. */
  private trackMeta(job: JobMeta): void {
    const pending = this.writeMeta(job)
      .catch((error) => logWarn(`could not write the state of ${job.id}: ${errorMessage(error)}`))
      .finally(() => this.pendingMeta.delete(pending))
    this.pendingMeta.add(pending)
  }

  /**
   * Reads back what earlier runs left. Every job a dead process left `running` is
   * marked `interrupted` — the child is gone, and saying otherwise would leave a
   * job that never ends.
   */
  private load(): void {
    let names: string[]
    try {
      ensurePrivateDir(jobsDir())
      names = readdirSync(jobsDir())
    } catch {
      return
    }
    for (const name of names) {
      if (!/^job_\d+$/.test(name)) continue
      this.seq = Math.max(this.seq, Number(name.slice('job_'.length)))
      const meta = this.readMeta(name)
      if (!meta) continue
      const state: JobState = meta.state === 'running' ? 'interrupted' : meta.state
      const record: JobRecord = {
        ...meta,
        state,
        ...(state !== meta.state ? { endedAt: Date.now() } : {}),
        logPath: jobLogFile(name),
        lines: this.readTail(jobLogFile(name)),
        partial: '',
        child: null,
        exited: Promise.resolve(),
        killing: false,
        spawned: false,
      }
      this.jobs.set(name, record)
      if (state !== meta.state) this.trackMeta(record)
    }
  }

  private readMeta(id: string): JobMeta | null {
    try {
      const raw = readFileSync(jobMetaFile(id), 'utf8')
      const parsed = JSON.parse(raw) as Partial<JobMeta>
      if (typeof parsed.id !== 'string' || typeof parsed.command !== 'string') return null
      return {
        id: parsed.id,
        command: parsed.command,
        cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
        notify: (parsed.notify as JobNotify) ?? 'auto',
        origin: parsed.origin ?? { gateway: 'local', conversationId: 'install' },
        state: (parsed.state as JobState) ?? 'error',
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        endedAt: typeof parsed.endedAt === 'number' ? parsed.endedAt : undefined,
        exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined,
      }
    } catch {
      return null
    }
  }

  private readTail(file: string): string[] {
    try {
      const size = statSync(file).size
      const length = Math.min(size, TAIL_BYTES)
      if (length === 0) return []
      const fd = openSync(file, 'r')
      try {
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, size - length)
        return buffer
          .toString('utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .slice(-MAX_LINES)
          .map((line) => line.slice(0, MAX_LINE_LENGTH))
      } finally {
        closeSync(fd)
      }
    } catch {
      return []
    }
  }
}
