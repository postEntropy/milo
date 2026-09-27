import { randomUUID } from 'node:crypto'
import { errorMessage } from '../../util/errors.js'

export type JobStatus = 'running' | 'done' | 'error'

/** A job as the browser sees it: what it is doing, and what it said along the way. */
export interface JobView {
  id: string
  kind: string
  status: JobStatus
  /** Progress lines, oldest first, capped; a download prints far more than fits. */
  lines: string[]
  result?: unknown
  error?: string
}

interface Job {
  id: string
  kind: string
  status: JobStatus
  lines: string[]
  result?: unknown
  error?: string
}

const MAX_LINES = 120
const MAX_LINE_LENGTH = 400
/** Jobs kept at once. Only a handful can be started by hand, so this is a ceiling, not a queue. */
const MAX_JOBS = 8

/**
 * Long-running setup work — a browser download, a profile copy, the local
 * embedding engine — as something the browser can watch. An HTTP request that
 * waited minutes for one of these would be a hung request; a job is started,
 * and its lines are polled until it ends.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>()

  /** Starts `runner`, which is handed a `say` for its progress lines. Returns the id at once. */
  start(kind: string, runner: (say: (line: string) => void) => Promise<unknown>): string {
    this.evict()
    const id = randomUUID()
    const job: Job = { id, kind, status: 'running', lines: [] }
    this.jobs.set(id, job)
    void runner((line) => append(job, line))
      .then((result) => {
        job.status = 'done'
        job.result = result
      })
      .catch((error: unknown) => {
        job.status = 'error'
        job.error = errorMessage(error)
      })
    return id
  }

  view(id: string): JobView | null {
    const job = this.jobs.get(id)
    if (!job) return null
    return { id: job.id, kind: job.kind, status: job.status, lines: [...job.lines], result: job.result, error: job.error }
  }

  /** Drops the oldest finished job when the list is full; never one still running. */
  private evict(): void {
    if (this.jobs.size < MAX_JOBS) return
    for (const job of this.jobs.values()) {
      if (job.status === 'running') continue
      this.jobs.delete(job.id)
      return
    }
  }
}

function append(job: Job, line: string): void {
  const text = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line
  job.lines.push(text)
  if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES)
}
