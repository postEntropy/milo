import { z } from 'zod'
import {
  describeJob,
  formatSteeredJobWait,
  waitForJobs,
  type JobInfo,
  type JobManager,
} from '../jobs/index.js'
import type { Tool, ToolResult } from './types.js'

/**
 * Whether a job belongs to the turn asking about it. A job is the session's that
 * started it, so a turn in another session is not told about it — the strip
 * draws the same rule.
 */
function isMine(job: JobInfo, sessionId?: string): boolean {
  return sessionId === undefined || job.sessionId === sessionId
}

function abortError(): Error {
  const error = new Error('the turn was stopped')
  error.name = 'AbortError'
  return error
}

const statusSchema = z.object({
  id: z
    .string()
    .optional()
    .describe('A job id, e.g. `job_3`. Omit to list every running or recent job.'),
})

/**
 * How a background job is going — the tool that answers "how is the download?".
 * Read-only, so it never asks and never interferes with the job it is looking at.
 */
export function createJobStatusTool(jobs: JobManager): Tool<z.infer<typeof statusSchema>> {
  return {
    name: 'job_status',
    description:
      'How a background job is doing: its state, how long it has run, its exit code, and the tail of its output. Use it to check output immediately; use `job_wait` when waiting for a job to finish.',
    schema: statusSchema,
    readOnly: true,
    concurrent: true,
    async execute(args, ctx): Promise<ToolResult> {
      if (args.id) {
        const job = jobs.get(args.id)
        if (!job || !isMine(job, ctx.sessionId)) return { content: `No job "${args.id}".`, isError: true }
        if (job.state !== 'running' && ctx.turnId && job.turnId === ctx.turnId) {
          jobs.consume(job.id)
        }
        return { content: describeJob(job, 40).trimEnd() }
      }
      const all = jobs.list(ctx.sessionId)
      if (all.length === 0) return { content: 'No background jobs.' }
      return { content: all.map((job) => describeJob(job, 8)).join('\n\n').trimEnd() }
    },
  }
}

const waitSchema = z.object({
  id: z
    .string()
    .optional()
    .describe('A single job id to wait on, e.g. `job_3`.'),
  ids: z
    .array(z.string())
    .optional()
    .describe('Job ids to wait on, e.g. `["job_3"]`. Omit both `id` and `ids` to wait on the running jobs of this turn/session.'),
  mode: z
    .enum(['all', 'any'])
    .optional()
    .describe('Wait until `all` target jobs finish (default) or `any` one finishes.'),
})

/**
 * Waits for one or more background jobs to finish inside the same turn.
 * Read-only so it never prompts for confirmation again, and responsive to
 * user steering and turn cancellation while waiting.
 */
export function createJobWaitTool(jobs: JobManager): Tool<z.infer<typeof waitSchema>> {
  return {
    name: 'job_wait',
    description:
      'Wait for one or more background jobs to finish and return their state, exit code, and output tail so you can continue in the same turn. Wakes early if the user sends guidance or stops the turn.',
    schema: waitSchema,
    readOnly: true,
    concurrent: false,
    async execute(args, ctx): Promise<ToolResult> {
      const requested = [...new Set([...(args.id ? [args.id] : []), ...(args.ids ?? [])])]
      let targetIds: string[] = []
      if (requested.length > 0) {
        for (const id of requested) {
          const job = jobs.get(id)
          if (!job || !isMine(job, ctx.sessionId)) return { content: `No job "${id}".`, isError: true }
          targetIds.push(id)
        }
      } else {
        const turnRunning = ctx.turnId ? jobs.runningForTurn(ctx.turnId) : []
        const sessionRunning =
          turnRunning.length > 0
            ? turnRunning
            : jobs.list(ctx.sessionId).filter((job) => job.state === 'running')
        if (sessionRunning.length > 0) {
          targetIds = sessionRunning.map((job) => job.id)
        } else {
          const settled = ctx.turnId ? jobs.unconsumedSettledForTurn(ctx.turnId, { includeDetached: true }) : []
          if (settled.length > 0) {
            for (const job of settled) jobs.consume(job.id)
            return { content: settled.map((job) => describeJob(job, 40).trimEnd()).join('\n\n') }
          }
          return { content: 'No running background jobs to wait for.' }
        }
      }

      const outcome = await waitForJobs(jobs, targetIds, {
        mode: args.mode ?? 'all',
        signal: ctx.signal,
        hasSteering: ctx.hasSteering,
      })

      if (outcome.kind === 'aborted') {
        throw abortError()
      }
      if (outcome.kind === 'steered') {
        for (const job of outcome.settled) jobs.consume(job.id)
        return { content: formatSteeredJobWait(outcome.settled, outcome.running) }
      }
      for (const job of outcome.jobs) jobs.consume(job.id)
      return { content: outcome.jobs.map((job) => describeJob(job, 40).trimEnd()).join('\n\n') }
    },
  }
}

const killSchema = z.object({
  id: z.string().describe('The job id to stop, e.g. `job_3`.'),
})

/** Stops a running job. A side effect, so it asks like any other. */
export function createJobKillTool(jobs: JobManager): Tool<z.infer<typeof killSchema>> {
  return {
    name: 'job_kill',
    description: 'Stops a running background job. Requires user confirmation.',
    schema: killSchema,
    readOnly: false,
    async execute(args, ctx): Promise<ToolResult> {
      const job = jobs.get(args.id)
      if (!job || !isMine(job, ctx.sessionId)) return { content: `No job "${args.id}".`, isError: true }
      if (job.state !== 'running') return { content: `Job ${args.id} is already ${job.state}.` }
      return jobs.kill(args.id, ctx.sessionId)
        ? { content: `Stopped job ${args.id}.` }
        : { content: `Could not stop job ${args.id}.`, isError: true }
    },
  }
}

export function createJobTools(jobs: JobManager): Tool<unknown>[] {
  return [createJobStatusTool(jobs), createJobWaitTool(jobs), createJobKillTool(jobs)]
}
