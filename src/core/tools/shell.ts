import { exec, execFile } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
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
    .describe(
      'Run in the background and return a job id instead of waiting. For a long command; no timeout, and you are told when it ends.',
    ),
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

/**
 * The `bwrap` arguments that put one command in a box: the machine read-only, the
 * workspace writable over it, no network, and the process dying with Milo rather
 * than outliving it.
 *
 * A pure function so what the sandbox promises can be read and tested without
 * running a command — the arguments are the policy.
 */
export function sandboxArgs(command: string, cwd: string, workspace: string): string[] {
  const home = path.resolve(homedir())
  // Hide sibling user folders too; in a normal Linux layout that is /home.
  // For /root, masking the parent would cover the whole filesystem, so mask only it.
  const homeRoot = path.dirname(home) === path.parse(home).root ? home : path.dirname(home)
  const runtime = path.dirname(process.execPath)
  const hostStateRoots = ['/var', '/run'].filter((directory) => existsSync(directory))
  const maskedRoots = [homeRoot, ...hostStateRoots].filter(
    (directory) => path.resolve(directory) !== path.resolve(workspace) && path.resolve(directory) !== path.resolve(runtime),
  )
  const projectHiddenRoot = maskedRoots.find((root) => strictlyInside(workspace, root))
  const runtimeHiddenRoot = maskedRoots.find((root) => strictlyInside(runtime, root))
  const projectIsHidden = projectHiddenRoot !== undefined
  const runtimeIsHidden = runtimeHiddenRoot !== undefined && !inside(runtime, workspace)
  const projectMount = '/tmp/milo-sandbox/project'
  const runtimeMount = '/tmp/milo-sandbox/runtime'
  const args = [
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    '--chmod', '1777', '/tmp',
    '--dir', '/tmp/milo-sandbox',
  ]
  if (projectIsHidden) {
    args.push('--dir', projectMount, '--bind', workspace, projectMount)
  } else {
    args.push('--bind', workspace, workspace)
  }
  if (runtimeIsHidden) {
    args.push('--dir', runtimeMount, '--ro-bind', runtime, runtimeMount)
  }
  // These contain host state or service sockets, not build inputs. A project
  // command gets private scratch space instead of the machine's databases.
  for (const directory of maskedRoots) args.push('--tmpfs', directory)
  if (maskedRoots.some((directory) => path.resolve(directory) === '/var')) {
    args.push('--dir', '/var/tmp', '--chmod', '1777', '/var/tmp')
  }
  // Keep ordinary runtime configuration available under /etc, but hide common
  // credential and private-key stores even when they are readable by this user.
  for (const directory of [
    '/etc/ssh',
    '/etc/NetworkManager/system-connections',
    '/etc/docker',
    '/etc/kubernetes',
    '/etc/wireguard',
    '/etc/letsencrypt',
    '/etc/ssl/private',
    '/etc/credstore',
    '/etc/credstore.encrypted',
  ]) {
    if (existsSync(directory)) args.push('--tmpfs', directory)
  }
  if (projectIsHidden) {
    addMaskedParents(args, projectHiddenRoot!, workspace)
    args.push('--symlink', projectMount, workspace)
  }
  if (runtimeIsHidden) {
    addMaskedParents(args, runtimeHiddenRoot!, runtime)
    args.push('--symlink', runtimeMount, runtime)
  }
  args.push(
    '--dev', '/dev',
    '--proc', '/proc',
    '--unshare-pid',
    '--unshare-net',
    '--die-with-parent',
    '--chdir', cwd,
    '--', '/bin/sh', '-c', command,
  )
  return args
}

/** Creates destinations hidden by the home tmpfs before binding an allowed path back. */
function addMaskedParents(args: string[], root: string, target: string): void {
  const absolute = path.resolve(target)
  const relative = path.relative(root, absolute)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return
  let current = root
  for (const part of path.dirname(relative).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    args.push('--dir', current)
  }
}

function strictlyInside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function inside(target: string, root: string): boolean {
  return path.resolve(target) === path.resolve(root) || strictlyInside(target, root)
}

function sandboxPath(workspace: string): string {
  return [
    path.join(workspace, 'node_modules', '.bin'),
    path.dirname(process.execPath),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter((entry) => existsSync(entry)).join(path.delimiter)
}

export const shellTool: Tool<ShellArgs> = {
  name: 'shell_command',
  description:
    'Run a shell command and return its combined stdout/stderr and exit code. Requires user confirmation. ' +
    'A command that walks a large tree (`du`, `find` over a whole disk) can outlast the default and be killed at the timeout — bound it with `timeout`, raise `timeoutMs`, or set `background` for a long command: it returns a job id at once and keeps running. A background job tells you when it ends — do not poll it; `job_status` is for output you need now, not for waiting.',
  schema,
  readOnly: false,
  async execute(args, ctx): Promise<ToolResult> {
    const cwd = args.cwd ? path.resolve(ctx.cwd, args.cwd) : ctx.cwd

    const canBackground = Boolean(ctx.jobs) && ctx.origin?.gateway !== ROUTINE_GATEWAY
    const sandboxed = ctx.sandbox === 'workspace'
    // A job is started by the manager from a command string, so there is no place
    // to put the box around it. Saying so is better than starting something the
    // person believed was contained.
    if (args.background && canBackground && sandboxed) {
      return {
        content:
          'The shell sandbox is on (sandbox: workspace), and a background job would run outside it. ' +
          'Run the command in the foreground, or turn the sandbox off.',
        isError: true,
      }
    }
    if (args.background && canBackground) {
      const started = ctx.jobs!.start({
        command: args.command,
        cwd,
        origin: ctx.origin ?? { gateway: 'local', chatId: 'install' },
        sessionId: ctx.sessionId,
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
    const done = (
      resolve: (result: ToolResult) => void,
      error: (Error & { code?: string | number | null; killed?: boolean }) | null,
      stdout: string,
      stderr: string,
    ) => {
      const combined = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim()
      const body = clipMiddle(combined || '(no output)', MAX_OUTPUT)

      if (sandboxed && error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({
          content:
            'The shell sandbox is on (sandbox: workspace), but bwrap is not installed. ' +
            'Install bubblewrap, or set `sandbox: off` in the config.',
          isError: true,
        })
        return
      }
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
    }

    return new Promise<ToolResult>((resolve) => {
      if (sandboxed) {
        // The workspace is the project's folder; a turn with no project works in
        // its own cwd, so that is the only thing it may write to.
        const workspace = ctx.confineTo ?? cwd
        execFile(
          'bwrap',
          sandboxArgs(args.command, cwd, workspace),
          {
            cwd,
            timeout,
            maxBuffer: MAX_BUFFER,
            signal: ctx.signal,
            env: {
              PATH: sandboxPath(workspace),
              HOME: '/tmp',
              TMPDIR: '/tmp',
              LANG: process.env.LANG ?? 'C.UTF-8',
              TERM: process.env.TERM ?? 'dumb',
            },
          },
          (error, stdout, stderr) => done(resolve, error, stdout, stderr),
        )
        return
      }
      exec(
        args.command,
        { cwd, timeout, maxBuffer: MAX_BUFFER, signal: ctx.signal },
        (error, stdout, stderr) => done(resolve, error, stdout, stderr),
      )
    })
  },
}
