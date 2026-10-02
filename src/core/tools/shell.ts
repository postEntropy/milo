import { exec } from 'node:child_process'
import path from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'
import { clipMiddle } from './output.js'

const schema = z.object({
  command: z.string().describe('Shell command to run (executed with /bin/sh).'),
  cwd: z.string().optional().describe('Working directory, relative to the working directory.'),
  timeoutMs: z.number().int().positive().optional().describe('Timeout in ms (default 30000, max 120000).'),
})

export type ShellArgs = z.infer<typeof schema>

const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 120_000
const MAX_OUTPUT = 20_000
const MAX_BUFFER = 10 * 1024 * 1024

export const shellTool: Tool<ShellArgs> = {
  name: 'shell_command',
  description:
    'Run a shell command and return its combined stdout/stderr and exit code. Requires user confirmation.',
  schema,
  readOnly: false,
  async execute(args, ctx): Promise<ToolResult> {
    const cwd = args.cwd ? path.resolve(ctx.cwd, args.cwd) : ctx.cwd
    const timeout = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)

    return new Promise<ToolResult>((resolve) => {
      exec(
        args.command,
        { cwd, timeout, maxBuffer: MAX_BUFFER, signal: ctx.signal },
        (error, stdout, stderr) => {
          const combined = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim()
          const body = clipMiddle(combined || '(no output)', MAX_OUTPUT)

          if (error?.killed) {
            resolve({ content: `Command timed out after ${timeout}ms.\n${body}`, isError: true })
            return
          }
          if (error && typeof error.code !== 'number') {
            resolve({ content: `Failed to run command: ${error.message}`, isError: true })
            return
          }

          const exitCode = error && typeof error.code === 'number' ? error.code : 0
          resolve({ content: `exit ${exitCode}\n${body}` })
        },
      )
    })
  },
}
