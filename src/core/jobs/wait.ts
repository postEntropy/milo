import { formatDuration } from '../../util/format.js'
import { describeJob } from './describe.js'
import type { JobManager } from './manager.js'
import type { JobInfo } from './types.js'

export interface WaitForJobsOptions {
  mode?: 'all' | 'any'
  signal?: AbortSignal
  hasSteering?: () => boolean
  steerPollMs?: number
}

export type WaitForJobsOutcome =
  | { kind: 'settled'; jobs: JobInfo[] }
  | { kind: 'steered'; settled: JobInfo[]; running: JobInfo[] }
  | { kind: 'aborted' }

const DEFAULT_STEER_POLL_MS = 25

/**
 * Waits for one or more jobs to settle while remaining responsive to turn
 * cancellation and mid-turn user steering. Event-driven via `onAnySettled`
 * so early completion never misses a wakeup.
 */
export function waitForJobs(
  manager: JobManager,
  ids: readonly string[],
  options: WaitForJobsOptions = {},
): Promise<WaitForJobsOutcome> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return Promise.resolve({ kind: 'settled', jobs: [] })

  const mode = options.mode ?? 'all'
  const evaluate = (): { done: boolean; settled: JobInfo[]; running: JobInfo[] } => {
    const settled: JobInfo[] = []
    const running: JobInfo[] = []
    for (const id of uniqueIds) {
      const job = manager.get(id)
      if (!job) continue
      if (job.state === 'running') running.push(job)
      else settled.push(job)
    }
    const done = running.length === 0 || (mode === 'any' && settled.length > 0)
    return { done, settled, running }
  }

  if (options.signal?.aborted) return Promise.resolve({ kind: 'aborted' })
  const initial = evaluate()
  if (initial.done) return Promise.resolve({ kind: 'settled', jobs: initial.settled })
  if (options.hasSteering?.()) {
    return Promise.resolve({ kind: 'steered', settled: initial.settled, running: initial.running })
  }

  return new Promise<WaitForJobsOutcome>((resolve) => {
    let finished = false
    let unlisten: () => void = () => undefined
    let steerTimer: ReturnType<typeof setInterval> | undefined

    const finish = (outcome: WaitForJobsOutcome) => {
      if (finished) return
      finished = true
      unlisten()
      options.signal?.removeEventListener('abort', onAbort)
      if (steerTimer) clearInterval(steerTimer)
      resolve(outcome)
    }

    const check = () => {
      if (options.signal?.aborted) {
        finish({ kind: 'aborted' })
        return
      }
      const snapshot = evaluate()
      if (snapshot.done) {
        finish({ kind: 'settled', jobs: snapshot.settled })
        return
      }
      if (options.hasSteering?.()) {
        finish({ kind: 'steered', settled: snapshot.settled, running: snapshot.running })
      }
    }

    const onAbort = () => finish({ kind: 'aborted' })

    unlisten = manager.onAnySettled(() => check())
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.hasSteering) {
      steerTimer = setInterval(() => {
        if (options.hasSteering?.()) check()
      }, options.steerPollMs ?? DEFAULT_STEER_POLL_MS)
      steerTimer.unref?.()
    }
    // Re-check after registering listeners so a settlement in the gap is never missed.
    check()
  })
}

/** Formats a settled job's result for delivery inside an active turn. */
export function formatTurnJobOutcome(job: JobInfo, maxLines = 40): string {
  const elapsed = formatDuration((job.endedAt ?? Date.now()) - job.startedAt)
  const outcome =
    job.state === 'done'
      ? `finished (exit ${job.exitCode ?? 0})`
      : job.state === 'killed'
        ? 'was stopped'
        : `failed (${job.exitCode === undefined ? 'no exit code' : `exit ${job.exitCode}`})`
  const lines = [`[job ${job.id} ${outcome} after ${elapsed}]`, `Command: ${job.command}`]
  const tail = job.lines.slice(-maxLines)
  if (tail.length > 0) lines.push('Output:', ...tail)
  return lines.join('\n')
}

/** Formats the internal continuation message injected into `messages` when turn jobs settle. */
export function formatTurnJobContinuation(
  settled: readonly JobInfo[],
  stillRunning: readonly JobInfo[] = [],
): string {
  const sections = settled.map((job) => formatTurnJobOutcome(job))
  if (stillRunning.length > 0) {
    sections.push(`Still running in this turn: ${stillRunning.map((job) => job.id).join(', ')}.`)
  }
  sections.push(
    'Not a message from the person. Continue the task in this turn using the result above (without repeating earlier progress updates). If a command failed or was stopped, diagnose, recover, or report the blocker.',
  )
  return sections.join('\n\n')
}

/** Formats the tool result for `job_wait` when interrupted by user steering. */
export function formatSteeredJobWait(
  settled: readonly JobInfo[],
  running: readonly JobInfo[],
): string {
  const parts: string[] = []
  if (settled.length > 0) {
    parts.push(...settled.map((job) => describeJob(job, 40).trimEnd()))
  }
  if (running.length > 0) {
    parts.push(
      'Wait interrupted by a new message from the user. Still running:\n' +
        running.map((job) => describeJob(job, 8).trimEnd()).join('\n\n'),
    )
  }
  return parts.join('\n\n')
}
