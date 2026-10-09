import { exec } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'
import { clipMiddle } from './output.js'

const schema = z.object({
  command: z.string().describe('Shell command to run (executed with /bin/sh).'),
  cwd: z.string().optional().describe('Working directory, relative to the working directory.'),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Timeout in ms (default 30000, max 120000). Ignored when `background` is set.'),
  background: z
    .boolean()
    .optional()
    .describe('Run in the background and return a job id instead of waiting. For a long command; no timeout.'),
  notify: z
    .enum(['auto', 'always', 'never'])
    .optional()
    .describe(
      'For a background job: who to tell when it ends. `always` if the person asked, `never` if they asked not to, `auto` (default) to decide then.',
    ),
})

export type ShellArgs = z.infer<typeof schema>

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 120_000
const MAX_OUTPUT = 20_000
const MAX_BUFFER = 10 * 1024 * 1024

/** The scope tag a routine's own run carries; a background job does not belong there. */
const ROUTINE_GATEWAY = 'routine'

export const shellTool: Tool<ShellArgs> = {
  name: 'shell_command',
  description:
    'Run a shell command and return its combined stdout/stderr and exit code. Requires user confirmation. Set `background` for a long command: it returns a job id at once and keeps running.',
  schema,
  readOnly: false,
  async execute(args, ctx): Promise<ToolResult> {
    const cwd = args.cwd ? path.resolve(ctx.cwd, args.cwd) : ctx.cwd

    const canBackground = Boolean(ctx.jobs) && ctx.origin?.gateway !== ROUTINE_GATEWAY
    if (args.background && canBackground) {
      const started = ctx.jobs!.start({
        command: args.command,
        cwd,
        origin: ctx.origin ?? { gateway: 'local', conversationId: 'install' },
        notify: args.notify,
      })
      if (!started.ok) return { content: started.error, isError: true }
      return {
        content:
          `Started job ${started.job.id}: ${args.command}\n` +
          'It runs in the background — the person sees it in the job indicator. ' +
          'Check on it with job_status, stop it with job_kill. You will be told when it ends.',
      }
    }

    const note = args.background
      ? ctx.jobs
        ? 'Background is not available inside a routine, so the command ran in the foreground.\n'
        : 'Background jobs are not available here, so the command ran in the foreground.\n'
      : ''

    const timeout = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    return new Promise<ToolResult>((resolve) => {
      exec(
        args.command,
        { cwd, timeout, maxBuffer: MAX_BUFFER, signal: ctx.signal },
        (error, stdout, stderr) => {
          const combined = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim()
          const body = clipMiddle(combined || '(no output)', MAX_OUTPUT)

          if (error?.killed) {
            resolve({ content: `${note}Command timed out after ${timeout}ms.\n${body}`, isError: true })
            return
          }
          if (error && typeof error.code !== 'number') {
            resolve({ content: `${note}Failed to run command: ${error.message}`, isError: true })
            return
          }

          const exitCode = error && typeof error.code === 'number' ? error.code : 0
          resolve({ content: `${note}exit ${exitCode}\n${body}` })
        },
      )
    })
  },
}
