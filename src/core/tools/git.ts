import { execFile } from 'node:child_process'
import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'
import { clipMiddle } from './output.js'

const MAX_OUTPUT = 20_000
const DEFAULT_LOG_LIMIT = 20
const MAX_LOG_LIMIT = 200
/** A hung hook or a `git` waiting on something must not hang the whole turn. */
const TIMEOUT = 60_000
const MAX_BUFFER = 10 * 1024 * 1024

/**
 * `git` is a program of its own, not a shell: it is run through `execFile` with
 * an argument list, so nothing typed into `path` or `ref` can become a second
 * command. Paging and colour are turned off because the output is read as text,
 * and the terminal prompt is closed so an operation that would want credentials
 * fails instead of hanging with nobody to answer.
 */
function runGit(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<{ code: number; body: string } | { failed: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'color.ui=false', '--no-pager', ...args],
      {
        cwd,
        signal,
        timeout: TIMEOUT,
        maxBuffer: MAX_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout, stderr) => {
        const nodeError = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
        if (nodeError && nodeError.code === 'ENOENT') {
          resolve({ failed: 'git is not installed or not on PATH.' })
          return
        }
        if (nodeError?.killed || nodeError?.name === 'AbortError') {
          resolve({ failed: 'the git command was stopped.' })
          return
        }
        const combined = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim()
        const code = nodeError && typeof nodeError.code === 'number' ? nodeError.code : 0
        resolve({ code, body: combined })
      },
    )
  })
}

function render(result: { code: number; body: string } | { failed: string }): ToolResult {
  if ('failed' in result) return { content: result.failed, isError: true }
  const body = clipMiddle(result.body || '(no output)', MAX_OUTPUT)
  return { content: `exit ${result.code}\n${body}`, isError: result.code !== 0 }
}

const readSchema = z.object({
  action: z
    .enum(['status', 'diff', 'log', 'show', 'blame'])
    .describe('Which read to run: the working tree (status), changes (diff), history (log, show) or line authorship (blame).'),
  path: z.string().optional().describe('A file or directory the read is about (status, diff, log, blame).'),
  ref: z.string().optional().describe('A revision — a branch, tag or commit (diff, log, show, blame).'),
  staged: z.boolean().optional().describe('diff: show what is staged (--cached) rather than the working tree.'),
  limit: z.number().int().positive().optional().describe(`log: how many commits (default ${DEFAULT_LOG_LIMIT}, max ${MAX_LOG_LIMIT}).`),
})

export type GitArgs = z.infer<typeof readSchema>

type ReadAction = GitArgs['action']

/**
 * What each read takes, so an argument that has no meaning for the chosen
 * action is refused by name rather than silently ignored. A command given an
 * argument it does not recognise answers with the valid ones — it never falls
 * back to a default without saying so.
 */
const READ_ARGS: Record<ReadAction, readonly string[]> = {
  status: ['path'],
  diff: ['path', 'ref', 'staged'],
  log: ['path', 'ref', 'limit'],
  show: ['ref'],
  blame: ['path', 'ref'],
}

/** The reads, spelled once so a new action cannot be added to one place only. */
const ACTIONS: ReadAction[] = ['status', 'diff', 'log', 'show', 'blame']

export const gitTool: Tool<GitArgs> = {
  name: 'git',
  description:
    'Read a git repository: the working tree (`status`), changes (`diff`), history (`log`, `show`) or who last changed a line (`blame`). Read-only, so it never asks. Commits are made with `git_commit`.',
  schema: readSchema,
  readOnly: true,
  async execute(args, ctx) {
    const { action } = args
    const allowed = READ_ARGS[action]
    for (const key of ['path', 'ref', 'staged', 'limit'] as const) {
      if (args[key] !== undefined && !allowed.includes(key)) {
        const takes = allowed.length > 0 ? allowed.join(', ') : 'no extra arguments'
        return {
          content: `git ${action} does not take \`${key}\` — it takes ${takes}. Valid actions: ${ACTIONS.join(', ')}.`,
          isError: true,
        }
      }
    }
    if (action === 'blame' && !args.path?.trim()) {
      return { content: "git blame needs a path — git(action: 'blame', path: '<file>').", isError: true }
    }

    const path = args.path?.trim() || undefined
    const requestedRef = args.ref?.trim() || undefined
    // Resolve user supplied revisions to an object id before passing them to
    // another Git command. Besides rejecting invalid revisions, this prevents
    // a value such as `--output=/tmp/file` from becoming a Git option. The
    // `--end-of-options` boundary also protects rev-parse itself.
    let ref = requestedRef
    if (requestedRef) {
      const resolved = await runGit(ctx.cwd, ['rev-parse', '--verify', '--end-of-options', `${requestedRef}^{object}`], ctx.signal)
      if ('failed' in resolved) return { content: resolved.failed, isError: true }
      if (resolved.code !== 0) return render(resolved)
      ref = resolved.body.split('\n', 1)[0]
    }
    const argv: string[] = (() => {
      switch (action) {
        case 'status':
          return ['status', '--short', '--branch', ...(path ? ['--', path] : [])]
        case 'diff':
          return ['diff', ...(args.staged ? ['--cached'] : []), ...(ref ? [ref] : []), ...(path ? ['--', path] : [])]
        case 'log':
          return [
            'log',
            '--oneline',
            `--max-count=${Math.min(args.limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT)}`,
            ...(ref ? [ref] : []),
            ...(path ? ['--', path] : []),
          ]
        case 'show':
          return ['show', ref ?? 'HEAD']
        case 'blame':
          return ['blame', ...(ref ? [ref] : []), '--', path as string]
      }
    })()

    return render(await runGit(ctx.cwd, argv, ctx.signal))
  },
}

const commitSchema = z.object({
  message: z.string().describe('The commit message. Required — a commit with no message is refused.'),
  files: z.array(z.string()).optional().describe('Paths to stage before committing.'),
  all: z.boolean().optional().describe('Stage every tracked change (git commit -a) instead of naming files.'),
})

export type GitCommitArgs = z.infer<typeof commitSchema>

export const gitCommitTool: Tool<GitCommitArgs> = {
  name: 'git_commit',
  description:
    'Stage files and commit them. Requires confirmation. Name what to stage with `files`, or set `all` for every tracked change; with neither, only what is already staged is committed.',
  schema: commitSchema,
  readOnly: false,
  async execute(args, ctx) {
    const message = args.message.trim()
    if (!message) return { content: 'A commit needs a message.', isError: true }
    if (args.files && args.all) {
      return { content: 'Give either `files` or `all`, not both — one way of choosing what to stage.', isError: true }
    }
    const files = args.files?.map((file) => file.trim()).filter(Boolean) ?? []
    if (args.files && files.length === 0) {
      return { content: '`files` was empty — name at least one path, or use `all`.', isError: true }
    }

    if (files.length > 0) {
      const staged = await runGit(ctx.cwd, ['add', '--', ...files], ctx.signal)
      if ('failed' in staged) return { content: staged.failed, isError: true }
      if (staged.code !== 0) {
        return { content: `Could not stage ${files.join(', ')}:\n${clipMiddle(staged.body, MAX_OUTPUT)}`, isError: true }
      }
    }

    const result = await runGit(ctx.cwd, ['commit', ...(args.all ? ['-a'] : []), '-m', message], ctx.signal)
    return render(result)
  },
}
