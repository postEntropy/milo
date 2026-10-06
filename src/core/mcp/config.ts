import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { z } from 'zod'
import { writePrivateFile } from '../../util/fs.js'
import { errorMessage } from '../../util/errors.js'
import { logWarn } from '../../util/log.js'
import { mcpFile } from '../config/paths.js'

/**
 * The external tool servers Milo may talk to, read from `~/.milo/mcp.json`.
 *
 * A file rather than a settings form, the same way the routine list is: what a
 * server is, is a command line and its arguments, and a hand-edited file is a
 * truer way to say that than a form that would have to grow a text box per
 * argument. The settings surfaces report what the file holds and where it is,
 * which is the part that has to be visible for a server that failed to start.
 *
 * The server's own `readOnlyHint` is deliberately not read: the spec says a
 * client must treat annotations as untrusted, and a server that could grant
 * itself "this never asks" would be answering the permission question about
 * itself. `readOnly` below is the person's declaration, and only theirs.
 */
export const McpServerSchema = z.strictObject({
  /** The executable to launch. Resolved through `PATH` like any other command. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /**
   * Environment for the subprocess, added to Milo's own. A value may name a
   * variable (`"${GITHUB_TOKEN}"`) so a token stays in the environment instead
   * of in this file — resolved when the server starts, and reported when the
   * variable is not set.
   */
  env: z.record(z.string(), z.string()).default({}),
  /** Where it runs. Absent means Milo's own working directory. */
  cwd: z.string().optional(),
  /** Off keeps it out of the catalog without deleting what it took to set up. */
  enabled: z.boolean().default(true),
  /**
   * Tools of this server that only read, by the name the *server* gave them.
   * The person's word, not the server's: those never ask, everything else asks
   * unless the policy says otherwise.
   */
  readOnly: z.array(z.string()).default([]),
  /** How long one tool call may take before it is abandoned. */
  timeoutMs: z.number().int().positive().default(120_000),
})

export type McpServerConfig = z.infer<typeof McpServerSchema>

export const McpConfigSchema = z.strictObject({
  servers: z.record(z.string(), McpServerSchema).default({}),
})

export type McpConfig = z.infer<typeof McpConfigSchema>

/**
 * A server's name is what its tools are prefixed with, so it has to be a name a
 * tool may carry. Single `_`/`-` separators only: a double underscore would make
 * `mcp__<server>__<tool>` ambiguous to read back, and the surfaces parse that
 * name to show it.
 */
const SERVER_NAME = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/

/**
 * What the file says, or an error saying which line is wrong. Strict: a
 * misspelled key is a setting the person wrote and Milo would otherwise ignore
 * in silence, which is the same defect as a control that does nothing.
 */
export function readMcpConfig(): McpConfig {
  const file = mcpFile()
  if (!existsSync(file)) return { servers: {} }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${errorMessage(error)}`)
  }
  const parsed = McpConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`${file} is not a valid MCP config — ${describeIssues(parsed.error)}`)
  }
  for (const name of Object.keys(parsed.data.servers)) {
    if (!SERVER_NAME.test(name)) {
      throw new Error(
        `${file}: "${name}" is not a valid server name. Use lowercase letters, digits and single ` +
          "underscores or hyphens, starting with a letter or digit — the name becomes the prefix of every tool it offers.",
      )
    }
  }
  return parsed.data
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'the file'
      if (issue.code === 'unrecognized_keys' && 'keys' in issue && Array.isArray(issue.keys)) {
        return `${path} has no field named ${issue.keys.map((key) => `"${key}"`).join(', ')}`
      }
      return `${path}: ${issue.message}`
    })
    .join('; ')
}

/**
 * The environment a server is started with: Milo's own, plus the file's, with
 * `${VAR}` resolved from the environment.
 *
 * A variable that is not set is an error rather than an empty value, because an
 * empty token reaches the server as "not authenticated" and the server reports
 * something else entirely — the person then debugs the server instead of the
 * config that was wrong.
 */
export function resolveMcpEnv(
  server: McpServerConfig,
  name: string,
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(server.env)) {
    resolved[key] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => {
      const fromEnv = process.env[variable]
      if (fromEnv === undefined) {
        throw new Error(
          `mcp.json → servers.${name}.env.${key} names \${${variable}}, which is not set in the environment.`,
        )
      }
      return fromEnv
    })
  }
  return resolved
}

const WRITE_LOCK_RETRIES = { retries: 15, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true }

/**
 * The file as it is, read leniently for the one write Milo makes to it: a
 * surface toggling a server must not refuse to work because another server's
 * `args` is malformed. What is written back is what was read, with the one
 * boolean moved.
 */
function readForWrite(): Record<string, unknown> {
  const file = mcpFile()
  if (!existsSync(file)) return { servers: {} }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${errorMessage(error)}`)
  }
  return (raw && typeof raw === 'object' ? raw : { servers: {} }) as Record<string, unknown>
}

/** Turns one server on or off in the file, and in nothing else. */
export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<void> {
  const file = mcpFile()
  mkdirSync(dirname(file), { recursive: true })
  const release = await lockfile.lock(file, {
    ...WRITE_LOCK_RETRIES,
    stale: 10_000,
    realpath: false,
  }).catch((error: unknown) => {
    // Reported, never swallowed: writing without the lock would do the very
    // concurrent edit the lock exists to prevent, and do it in silence.
    throw new Error(`could not lock ${file} to change "${name}": ${errorMessage(error)}`)
  })
  try {
    const object = readForWrite()
    const servers = (object.servers && typeof object.servers === 'object' ? object.servers : {}) as Record<string, unknown>
    const server = servers[name]
    if (!server || typeof server !== 'object') {
      throw new Error(`mcp.json has no server named "${name}".`)
    }
    servers[name] = { ...(server as Record<string, unknown>), enabled }
    await writePrivateFile(file, `${JSON.stringify({ ...object, servers }, null, 2)}\n`)
  } finally {
    await release().catch((error: unknown) => {
      logWarn(`could not release the mcp.json lock: ${errorMessage(error)}`)
    })
  }
}
