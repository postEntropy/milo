import { statSync } from 'node:fs'
import type { AgentEvent } from '../core/agent/events.js'
import { createRuntime } from '../core/bootstrap.js'
import { DEFAULT_WORKING_DIRECTORY } from '../core/config/paths.js'
import { configExists, loadConfig, type LoadedConfig } from '../core/config/load.js'
import { placeProject, resolveProjectRef } from '../core/projects.js'
import type { PermissionMode } from '../core/tools/permission.js'
import { resolveToolPath } from '../core/tools/walk.js'
import { errorMessage } from '../util/errors.js'
import { parseArgs } from './args.js'
import { resolveInitialMode, validateArgs } from './dispatch.js'
import { applyOverrides } from './overrides.js'

/**
 * `milo run`: one turn, no terminal UI. It is what a script or a cron job calls
 * when it wants the agent rather than a conversation — the prompt goes in, the
 * answer comes out, and the exit code says whether the turn finished.
 *
 * Everything it does with a project is the same as the chat's: the session runs
 * in the project's folder, reads its rules and uses the same tools. The one thing
 * it cannot do is ask, so a tool that needs confirmation fails rather than
 * waiting for an answer nobody is there to give. `--allow` and `--mode` are the
 * two ways to say what it may do unattended.
 */

/** What a one-shot run needs from a session: its name and its turn. */
export interface RunSession {
  id: string
  send(input: string): AsyncGenerator<AgentEvent>
}

/** The part of a runtime `milo run` uses. Narrow, so a test can answer without one. */
export interface RunRuntime {
  newSession(
    scope: { gateway: string; chatId: string },
    title?: string,
    options?: { project?: string },
  ): Promise<RunSession>
  resumeSession(
    scope: { gateway: string; chatId: string },
    id: string,
  ): Promise<RunSession | null>
  getSession(scope: { gateway: string; chatId: string }): Promise<RunSession>
  permissions?: { update(options: { mode?: PermissionMode; allow?: string[] }): void }
  close(): Promise<void>
}

export interface RunIo {
  out(text: string): void
  err(text: string): void
}

export interface RunDeps {
  /** The config already read, for a test; absent reads the install's. */
  loaded?: LoadedConfig
  /** A runtime to talk through, for a test; absent builds one. */
  runtime?: RunRuntime
  /** Swapped in tests, so nothing waits on a terminal that will never type. */
  readStdin?: () => Promise<string>
  /** Swapped in tests, so a project need not be registered on this machine. */
  resolveProject?: (ref: string) => { id: string; name: string; path: string } | undefined
}

/** The terminal's own scope, so `--continue` reaches the session it last used. */
const RUN_SCOPE = { gateway: 'cli', chatId: 'main' }

const defaultIo: RunIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}

/** The prompt from the command line, or all of stdin when it was piped in. */
async function readPrompt(args: ReturnType<typeof parseArgs>, deps: RunDeps): Promise<string> {
  if (args.prompt?.trim()) return args.prompt.trim()
  if (deps.readStdin) return (await deps.readStdin()).trim()
  // A terminal with nobody to type into would wait forever; stdin is only read
  // when it is not one.
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').trim()
}

export async function runCommand(
  argv: string[],
  io: RunIo = defaultIo,
  deps: RunDeps = {},
): Promise<number> {
  const args = parseArgs(argv)
  const problem = validateArgs(args)
  if (problem) {
    io.err(`${problem}\n`)
    return 1
  }

  let loaded = deps.loaded ?? null
  if (!loaded) {
    if (!configExists()) {
      io.err('Milo is not configured yet. Run `milo setup` first.\n')
      return 1
    }
    loaded = loadConfig()
    if (!loaded) {
      io.err('Milo is not configured yet. Run `milo setup` first.\n')
      return 1
    }
  }
  try {
    applyOverrides(loaded, args)
  } catch (error) {
    io.err(`${errorMessage(error)}\n`)
    return 1
  }

  const resolveProject = deps.resolveProject ?? ((ref: string) => resolveProjectRef(ref))
  const project = args.project ? resolveProject(args.project) : undefined
  if (args.project && !project) {
    io.err(`No project "${args.project}" is registered. See \`milo projects list\`, or add one with \`milo projects add\`.\n`)
    return 1
  }
  if (project && !deps.resolveProject) {
    const placement = placeProject(project.id)
    if (!placement.ok) {
      io.err(`${project.name}: ${placement.error}.\n`)
      return 1
    }
  }

  if (args.cwd) {
    const folder = resolveToolPath(process.cwd(), args.cwd)
    if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
      io.err(`--cwd "${args.cwd}" is not a folder.\n`)
      return 1
    }
  }

  const prompt = await readPrompt(args, deps)
  if (!prompt) {
    io.err('Nothing to do: give a prompt, or pipe one in on stdin.\n')
    return 1
  }

  const cwd = args.cwd ? resolveToolPath(process.cwd(), args.cwd) : DEFAULT_WORKING_DIRECTORY
  const runtime: RunRuntime = deps.runtime ?? createRuntime(loaded, cwd)
  try {
    let session: RunSession | null
    if (args.session) {
      session = await runtime.resumeSession(RUN_SCOPE, args.session)
      if (!session) {
        io.err(`No session "${args.session}".\n`)
        return 1
      }
    } else if (args.continueSession) {
      session = await runtime.getSession(RUN_SCOPE)
    } else {
      session = await runtime.newSession(
        RUN_SCOPE,
        undefined,
        project ? { project: project.id } : undefined,
      )
    }

    const mode = resolveInitialMode(args)
    if (runtime.permissions && (mode || args.allow.length > 0)) {
      runtime.permissions.update({
        ...(mode ? { mode } : {}),
        allow: [...loaded.config.permissions.allow, ...args.allow],
      })
    }

    let failed = false
    let aborted = false
    let wrote = false
    /** The gate's verdict, when the install turned it on. */
    let verified: boolean | undefined
    for await (const event of session.send(prompt)) {
      if (args.json) {
        io.out(`${JSON.stringify(event)}\n`)
        if (event.type === 'verification') verified = event.ok
        continue
      }
      if (event.type === 'text-delta') {
        io.out(event.delta)
        wrote = true
      } else if (event.type === 'error') {
        io.err(`${wrote ? '\n' : ''}${event.message}\n`)
        failed = true
      } else if (event.type === 'aborted') {
        aborted = true
      } else if (event.type === 'verification') {
        // The answer stays on stdout; the verdict goes to stderr, so a pipe
        // reading the answer is not handed the report with it.
        verified = event.ok
        io.err(`${event.text}\n`)
      }
    }
    if (wrote && !args.json) io.out('\n')
    // The exit code is the verdict: a turn whose checks failed is not a run that
    // succeeded, whatever the answer said.
    return failed || aborted || verified === false ? 1 : 0
  } finally {
    await runtime.close()
  }
}
