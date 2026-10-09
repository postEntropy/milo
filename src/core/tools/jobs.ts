import { z } from 'zod'
import { describeJob, type JobManager } from '../jobs/index.js'
import type { Tool, ToolResult } from './types.js'

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
      'How a background job is doing: its state, how long it has run, its exit code, and the tail of its output. Use it to answer how a download or other long command started with `shell_command background` is going.',
    schema: statusSchema,
    readOnly: true,
    concurrent: true,
    async execute(args): Promise<ToolResult> {
      if (args.id) {
        const job = jobs.get(args.id)
        if (!job) return { content: `No job "${args.id}".` }
        return { content: describeJob(job, 40).trimEnd() }
      }
      const all = jobs.list()
      if (all.length === 0) return { content: 'No background jobs.' }
      return { content: all.map((job) => describeJob(job, 8)).join('\n\n').trimEnd() }
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
    async execute(args): Promise<ToolResult> {
      const job = jobs.get(args.id)
      if (!job) return { content: `No job "${args.id}".`, isError: true }
      if (job.state !== 'running') return { content: `Job ${args.id} is already ${job.state}.` }
      return jobs.kill(args.id)
        ? { content: `Stopped job ${args.id}.` }
        : { content: `Could not stop job ${args.id}.`, isError: true }
    },
  }
}

export function createJobTools(jobs: JobManager): Tool<unknown>[] {
  return [createJobStatusTool(jobs), createJobKillTool(jobs)]
}
