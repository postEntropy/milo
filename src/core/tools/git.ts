import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Tool, ToolContext, ToolResult } from './types.js'
import { clipMiddle } from './output.js'
import { canonicalToolPath, isInsideFolder, resolveScopedPath } from './walk.js'

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
 *
 * Exported because reading git is one behaviour: the Work screen reads a working
 * tree through this too, so the flags, the timeout and what an absent `git` says
 * cannot differ between the agent's reader and the screen's.
 *
 * `raw` is for output that is *data* rather than reading: `status --porcelain -z`
 * begins with the two status letters, one of which is a space, so trimming the
 * body would eat the first entry's index status and shift its path a character.
 * A raw read also leaves stderr out, since a warning is not part of the protocol.
 */
export function runGit(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  options: { raw?: boolean } = {},
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
        const combined = options.raw
          ? stdout
          : `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim()
        const code = nodeError && typeof nodeError.code === 'number' ? nodeError.code : 0
        resolve({ code, body: combined })
      },
    )
  })
}

function render(result: { code: number; body: string } | { failed: string }, cwd?: string): ToolResult {
  if ('failed' in result) return { content: result.failed, isError: true }
  const body = clipMiddle(result.body || '(no output)', MAX_OUTPUT)
  const hint =
    result.code === 128 && cwd && /not a git repository/i.test(result.body)
      ? `\nRan in: ${cwd}. Pass \`repo\` (or use \`shell_command\` if needed) when the repository is elsewhere.`
      : ''
  return { content: `exit ${result.code}\n${body}${hint}`, isError: result.code !== 0 }
}

/**
 * Resolve an explicit `repo` directory, enforcing the project boundary when set.
 * Returns `{ ok: true, cwd }` or an error string suitable for returning directly to the model.
 */
async function resolveRepoDir(
  ctx: Pick<ToolContext, 'cwd' | 'confineTo'>,
  rawRepo?: string,
): Promise<{ ok: true; cwd: string } | { ok: false; error: string }> {
  const trimmed = rawRepo?.trim()
  if (!trimmed) return { ok: true, cwd: ctx.cwd }
  const scoped = resolveScopedPath(ctx.cwd, trimmed, ctx.confineTo)
  if (!scoped.ok) return scoped
  try {
    const info = await stat(scoped.path)
    if (!info.isDirectory()) return { ok: false, error: `Not a directory: ${trimmed}` }
    return { ok: true, cwd: scoped.path }
  } catch {
    return { ok: false, error: `Repository directory not found: ${trimmed}` }
  }
}

/**
 * When `repo` is omitted in a session outside a git repo (or when `path` targets
 * another repo in an unconfined session), derive git's working directory from `path`
 * so `git(action: 'status', path: '/other/repo')` works instead of failing in `ctx.cwd`.
 */
async function resolveReadTarget(
  ctx: Pick<ToolContext, 'cwd' | 'confineTo' | 'signal'>,
  rawRepo: string | undefined,
  rawPath: string | undefined,
): Promise<{ ok: true; cwd: string; targetPath?: string } | { ok: false; error: string }> {
  if (rawRepo?.trim()) {
    const repo = await resolveRepoDir(ctx, rawRepo)
    if (!repo.ok) return repo
    if (!rawPath?.trim()) return { ok: true, cwd: repo.cwd }
    const scoped = resolveScopedPath(repo.cwd, rawPath, ctx.confineTo)
    if (!scoped.ok) return scoped
    return { ok: true, cwd: repo.cwd, targetPath: path.relative(repo.cwd, scoped.path) || '.' }
  }

  if (!rawPath?.trim()) return { ok: true, cwd: ctx.cwd }
  const scoped = resolveScopedPath(ctx.cwd, rawPath, ctx.confineTo)
  if (!scoped.ok) return scoped

  const top = await runGit(ctx.cwd, ['rev-parse', '--show-toplevel'], ctx.signal)
  if (!('failed' in top) && top.code === 0) {
    const topRoot = canonicalToolPath(ctx.cwd, top.body.split('\n', 1)[0])
    if (isInsideFolder(scoped.path, topRoot)) {
      return { ok: true, cwd: ctx.cwd, targetPath: rawPath.trim() }
    }
  }

  try {
    const info = await stat(scoped.path)
    if (info.isDirectory()) return { ok: true, cwd: scoped.path, targetPath: '.' }
    return { ok: true, cwd: path.dirname(scoped.path), targetPath: path.basename(scoped.path) }
  } catch {
    return { ok: true, cwd: ctx.cwd, targetPath: rawPath.trim() }
  }
}

const readSchema = z.object({
  action: z
    .enum(['status', 'diff', 'log', 'show', 'blame'])
    .describe('Which read to run: the working tree (status), changes (diff), history (log, show) or line authorship (blame).'),
  repo: z.string().optional().describe('Repository directory to read (defaults to the session working directory).'),
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
  status: ['repo', 'path'],
  diff: ['repo', 'path', 'ref', 'staged'],
  log: ['repo', 'path', 'ref', 'limit'],
  show: ['repo', 'ref'],
  blame: ['repo', 'path', 'ref'],
}

/** The reads, spelled once so a new action cannot be added to one place only. */
const ACTIONS: ReadAction[] = ['status', 'diff', 'log', 'show', 'blame']

export const gitTool: Tool<GitArgs> = {
  name: 'git',
  description:
    'Read a git repository: the working tree (`status`), changes (`diff`), history (`log`, `show`) or who last changed a line (`blame`). Runs in `repo` (or the session directory when omitted). Read-only, so it never asks. Commits are made with `git_commit`.',
  schema: readSchema,
  readOnly: true,
  async execute(args, ctx) {
    const { action } = args
    const allowed = READ_ARGS[action]
    for (const key of ['repo', 'path', 'ref', 'staged', 'limit'] as const) {
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

    const target = await resolveReadTarget(ctx, args.repo, args.path)
    if (!target.ok) return { content: target.error, isError: true }

    const { cwd: gitCwd, targetPath: gitPath } = target
    const requestedRef = args.ref?.trim() || undefined
    // Resolve user supplied revisions to an object id before passing them to
    // another Git command. Besides rejecting invalid revisions, this prevents
    // a value such as `--output=/tmp/file` from becoming a Git option. The
    // `--end-of-options` boundary also protects rev-parse itself.
    let ref = requestedRef
    if (requestedRef) {
      const resolved = await runGit(gitCwd, ['rev-parse', '--verify', '--end-of-options', `${requestedRef}^{object}`], ctx.signal)
      if ('failed' in resolved) return { content: resolved.failed, isError: true }
      if (resolved.code !== 0) return render(resolved, gitCwd)
      ref = resolved.body.split('\n', 1)[0]
    }
    const argv: string[] = (() => {
      switch (action) {
        case 'status':
          return ['status', '--short', '--branch', ...(gitPath ? ['--', gitPath] : [])]
        case 'diff':
          return ['diff', ...(args.staged ? ['--cached'] : []), ...(ref ? [ref] : []), ...(gitPath ? ['--', gitPath] : [])]
        case 'log':
          return [
            'log',
            '--oneline',
            `--max-count=${Math.min(args.limit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT)}`,
            ...(ref ? [ref] : []),
            ...(gitPath ? ['--', gitPath] : []),
          ]
        case 'show':
          return ['show', ref ?? 'HEAD']
        case 'blame':
          return ['blame', ...(ref ? [ref] : []), '--', gitPath as string]
      }
    })()

    return render(await runGit(gitCwd, argv, ctx.signal), gitCwd)
  },
}

const commitSchema = z.object({
  message: z.string().describe('The commit message. Required — a commit with no message is refused.'),
  repo: z.string().optional().describe('Repository directory to commit in (defaults to the session working directory).'),
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

    const repo = await resolveRepoDir(ctx, args.repo)
    if (!repo.ok) return { content: repo.error, isError: true }

    const scopedFiles: string[] = []
    for (const file of files) {
      const scoped = resolveScopedPath(repo.cwd, file, ctx.confineTo)
      if (!scoped.ok) return { content: scoped.error, isError: true }
      scopedFiles.push(path.relative(repo.cwd, scoped.path) || '.')
    }

    if (scopedFiles.length > 0) {
      const staged = await runGit(repo.cwd, ['add', '--', ...scopedFiles], ctx.signal)
      if ('failed' in staged) return { content: staged.failed, isError: true }
      if (staged.code !== 0) {
        return { content: `Could not stage ${files.join(', ')}:\n${clipMiddle(staged.body, MAX_OUTPUT)}`, isError: true }
      }
    }

    const result = await runGit(repo.cwd, ['commit', ...(args.all ? ['-a'] : []), '-m', message], ctx.signal)
    return render(result, repo.cwd)
  },
}
