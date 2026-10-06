import { existsSync, readFileSync } from 'node:fs'
import { errorMessage } from '../../util/errors.js'
import { writePrivateFile } from '../../util/fs.js'
import { logWarn } from '../../util/log.js'
import { mcpCacheFile } from '../config/paths.js'
import type { McpToolDefinition } from './protocol.js'

/**
 * What each server last said its tools were.
 *
 * This is the reason MCP costs nothing at startup: the catalog is assembled from
 * this file before any subprocess exists, so the first turn has the same tools as
 * the one before it, and the live listing — which needs a server running and a
 * round trip — only ever *corrects* what is here, in the background. Nothing
 * waits for it.
 *
 * Derived state, and treated as such: a cache that cannot be parsed is ignored
 * rather than fatal, and two Milo processes writing at once cost one round trip,
 * not correctness.
 */
export interface CachedServer {
  /** Which era answered, so a legacy server is not probed again on the next run. */
  era: 'modern' | 'legacy'
  version: string
  tools: McpToolDefinition[]
  /** When this listing came back, for a surface that wants to say how old it is. */
  at: number
}

export interface McpCache {
  servers: Record<string, CachedServer>
}

function isToolDefinition(value: unknown): value is McpToolDefinition {
  if (!value || typeof value !== 'object') return false
  const tool = value as Record<string, unknown>
  if (typeof tool.name !== 'string' || tool.name === '') return false
  if (tool.description !== undefined && typeof tool.description !== 'string') return false
  if (tool.inputSchema !== undefined && (typeof tool.inputSchema !== 'object' || tool.inputSchema === null)) return false
  return true
}

/** A cached server, or null when the entry is not one. */
function asCachedServer(value: unknown): CachedServer | null {
  if (!value || typeof value !== 'object') return null
  const server = value as Record<string, unknown>
  const era = server.era === 'legacy' ? 'legacy' : 'modern'
  const version = typeof server.version === 'string' ? server.version : ''
  const at = typeof server.at === 'number' ? server.at : 0
  if (!Array.isArray(server.tools) || !server.tools.every(isToolDefinition)) return null
  return { era, version, tools: server.tools, at }
}

export function readMcpCache(): McpCache {
  const file = mcpCacheFile()
  if (!existsSync(file)) return { servers: {} }
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const servers = (value && typeof value === 'object' ? (value as Record<string, unknown>).servers : null)
    if (!servers || typeof servers !== 'object') return { servers: {} }
    const kept: Record<string, CachedServer> = {}
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
      const cached = asCachedServer(entry)
      // A listing Milo cannot read is dropped, not reported: it is derived
      // state, and the next connection to that server rebuilds it.
      if (cached) kept[name] = cached
    }
    return { servers: kept }
  } catch (error) {
    logWarn(`could not read ${file} (the MCP catalog will be rebuilt): ${errorMessage(error)}`)
    return { servers: {} }
  }
}

export async function writeMcpCache(cache: McpCache): Promise<void> {
  try {
    await writePrivateFile(mcpCacheFile(), `${JSON.stringify(cache, null, 2)}\n`)
  } catch (error) {
    // The catalog was still correct for this run; failing to persist it only
    // costs the next run a round trip.
    logWarn(`could not write the MCP cache: ${errorMessage(error)}`)
  }
}
