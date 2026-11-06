import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ContentPart, Message } from './providers/types.js'
import { countMessages, previewOf, type SessionRecord } from './sessions/types.js'
import type { NativeSessionHistory } from './session-backend.js'

interface NativeEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  version?: number
  cwd?: string
  message?: {
    role?: string
    content?: unknown
    meta?: {
      source?: string
      createdAt?: number
    }
  }
}

interface CachedHistory {
  path: string
  size: number
  mtime: number
  history: NativeSessionHistory
}

export class CommandCodeHistoryReader {
  private readonly cache = new Map<string, CachedHistory>()
  private readonly projectsDirectory: string

  constructor(home = os.homedir()) {
    this.projectsDirectory = path.join(home, '.commandcode', 'projects')
  }

  read(record: SessionRecord): NativeSessionHistory {
    const backend = record.backend
    if (backend?.kind !== 'command-code') throw new Error(`Session ${record.id} does not use Command Code.`)
    const file = backend.nativeSessionId
      ? this.locateById(backend.nativeSessionId, backend.workingDirectory)
      : this.locateByTitle(backend.nativeTitle, backend.workingDirectory)
    if (!file) {
      return {
        messages: [],
        preview: '',
        messageCount: 0,
        updatedAt: record.createdAt,
      }
    }
    const info = statSync(file)
    const id = path.basename(file, '.jsonl')
    const cached = this.cache.get(id)
    if (cached && cached.path === file && cached.size === info.size && cached.mtime === info.mtimeMs) return cached.history
    const raw = readFileSync(file, 'utf8')
    const entries = this.parseEntries(raw)
    const history = this.parseHistory(entries, id, backend.workingDirectory, info.mtimeMs)
    this.cache.set(id, { path: file, size: info.size, mtime: info.mtimeMs, history })
    return history
  }

  private locateById(nativeSessionId: string, workingDirectory: string): string {
    if (!/^[a-f0-9-]{16,64}$/i.test(nativeSessionId)) throw new Error('Command Code returned an invalid native session id.')
    const matches = this.findTranscriptFiles(nativeSessionId, workingDirectory)
    if (matches.length === 0) throw new Error(`Native Command Code history ${nativeSessionId} was not found in ${workingDirectory}.`)
    if (matches.length > 1) throw new Error(`Native Command Code session ${nativeSessionId} has more than one matching transcript.`)
    return matches[0]!
  }

  private locateByTitle(nativeTitle: string, workingDirectory: string): string | null {
    if (!existsSync(this.projectsDirectory)) return null
    const matches: string[] = []
    for (const directory of readdirSync(this.projectsDirectory, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const projectDirectory = path.join(this.projectsDirectory, directory.name)
      for (const entry of readdirSync(projectDirectory)) {
        if (!entry.endsWith('.meta.json')) continue
        const metaFile = path.join(projectDirectory, entry)
        let meta: unknown
        try { meta = JSON.parse(readFileSync(metaFile, 'utf8')) } catch { continue }
        if (!meta || typeof meta !== 'object' || (meta as Record<string, unknown>).title !== nativeTitle) continue
        const nativeSessionId = entry.slice(0, -'.meta.json'.length)
        if (!/^[a-f0-9-]{16,64}$/i.test(nativeSessionId)) continue
        matches.push(...this.findTranscriptFiles(nativeSessionId, workingDirectory))
      }
    }
    const unique = [...new Set(matches)]
    if (unique.length > 1) throw new Error(`The Command Code title “${nativeTitle}” matches more than one native Session.`)
    return unique[0] ?? null
  }

  private findTranscriptFiles(nativeSessionId: string, workingDirectory: string): string[] {
    if (!existsSync(this.projectsDirectory)) return []
    const expectedCwd = this.canonicalPath(workingDirectory)
    const matches: string[] = []
    for (const directory of readdirSync(this.projectsDirectory, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const file = path.join(this.projectsDirectory, directory.name, `${nativeSessionId}.jsonl`)
      if (!existsSync(file)) continue
      const header = this.readHeader(file)
      if (header?.id === nativeSessionId && typeof header.cwd === 'string' && this.canonicalPath(header.cwd) === expectedCwd) {
        matches.push(file)
      }
    }
    return matches
  }

  private readHeader(file: string): NativeEntry | null {
    const descriptor = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(8192)
      const bytes = readSync(descriptor, buffer, 0, buffer.length, 0)
      const first = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0]
      const value: unknown = JSON.parse(first ?? '')
      return value && typeof value === 'object' && !Array.isArray(value) ? value as NativeEntry : null
    } catch {
      return null
    } finally {
      closeSync(descriptor)
    }
  }

  private canonicalPath(value: string): string {
    const resolved = path.resolve(value)
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  }

  private parseEntries(raw: string): NativeEntry[] {
    const lines = raw.split(/\r?\n/)
    const entries: NativeEntry[] = []
    for (const [index, line] of lines.entries()) {
      if (!line) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (error) {
        if (index === lines.length - 1 && !raw.endsWith('\n') && !raw.endsWith('\r')) break
        throw new Error(`Command Code transcript line ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).type !== 'string') {
        throw new Error(`Command Code transcript line ${index + 1} has an invalid record.`)
      }
      entries.push(value as NativeEntry)
    }
    return entries
  }

  private parseHistory(
    entries: NativeEntry[],
    nativeSessionId: string,
    workingDirectory: string,
    fileMtime: number,
  ): NativeSessionHistory {
    const header = entries[0]
    if (header?.type !== 'session' || header.id !== nativeSessionId || header.cwd === undefined ||
      this.canonicalPath(header.cwd) !== this.canonicalPath(workingDirectory)) {
      throw new Error(`Command Code transcript ${nativeSessionId} does not match this Session's folder.`)
    }
    const byId = new Map<string, NativeEntry>()
    for (const entry of entries.slice(1)) {
      if (typeof entry.id !== 'string') continue
      if (byId.has(entry.id)) throw new Error(`Command Code transcript ${nativeSessionId} repeats entry ${entry.id}.`)
      byId.set(entry.id, entry)
    }
    const branch: NativeEntry[] = []
    const visited = new Set<string>()
    let current = entries.at(-1)
    while (current && current.type !== 'session') {
      if (typeof current.id !== 'string' || visited.has(current.id)) {
        throw new Error(`Command Code transcript ${nativeSessionId} has an invalid parent chain.`)
      }
      visited.add(current.id)
      branch.push(current)
      const parentId = current.parentId
      if (parentId === null || parentId === undefined || parentId === nativeSessionId) break
      const parent = byId.get(parentId)
      if (!parent) throw new Error(`Command Code transcript ${nativeSessionId} is missing parent ${parentId}.`)
      current = parent
    }
    branch.reverse()
    const messages: Message[] = []
    const toolNames = new Map<string, string>()
    for (const entry of branch) {
      if (entry.type !== 'message' || !entry.message) continue
      const role = entry.message.role
      const source = entry.message.meta?.source
      const timestamp = typeof entry.message.meta?.createdAt === 'number'
        ? entry.message.meta.createdAt
        : typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined
      const at = timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : undefined
      const content = Array.isArray(entry.message.content) ? entry.message.content : null
      if (!content) throw new Error(`Command Code message ${entry.id ?? ''} has invalid content.`)
      if (role === 'assistant' && source === 'model') {
        const parts: ContentPart[] = []
        for (const rawPart of content) {
          if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) throw new Error('Command Code returned an invalid content block.')
          const part = rawPart as Record<string, unknown>
          if (part.type === 'text' && typeof part.text === 'string') {
            parts.push({ type: 'text', text: part.text })
          } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
            parts.push({ type: 'reasoning', text: part.thinking, ...(typeof part.signature === 'string' ? { signature: part.signature } : {}) })
          } else if (part.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string') {
            toolNames.set(part.id, part.name)
            parts.push({ type: 'tool-call', id: part.id, name: part.name, args: part.input ?? {} })
          } else {
            throw new Error(`Command Code content block ${String(part.type)} is not supported in the Milo transcript.`)
          }
        }
        if (parts.length > 0) messages.push({ role: 'assistant', content: parts, ...(at !== undefined ? { at } : {}) })
        continue
      }
      if (role === 'user' && source === 'user') {
        const parts: ContentPart[] = []
        for (const rawPart of content) {
          if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) throw new Error('Command Code returned an invalid user content block.')
          const part = rawPart as Record<string, unknown>
          if (part.type !== 'text' || typeof part.text !== 'string') {
            throw new Error(`Command Code user content block ${String(part.type)} is not supported in the Milo transcript.`)
          }
          parts.push({ type: 'text', text: part.text })
        }
        messages.push({ role: 'user', content: parts, ...(at !== undefined ? { at } : {}) })
        continue
      }
      if (role === 'user' && source === 'tool') {
        for (const rawPart of content) {
          if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) throw new Error('Command Code returned an invalid tool result block.')
          const part = rawPart as Record<string, unknown>
          if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string' || !Array.isArray(part.content)) {
            throw new Error(`Command Code tool result ${String(part.type)} is not supported in the Milo transcript.`)
          }
          const text = part.content.map((contentPart) => {
            if (!contentPart || typeof contentPart !== 'object' || Array.isArray(contentPart)) return ''
            const block = contentPart as Record<string, unknown>
            return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
          }).join('')
          messages.push({
            role: 'tool',
            content: [{
              type: 'tool-result',
              id: part.tool_use_id,
              name: toolNames.get(part.tool_use_id) ?? 'Command Code tool',
              content: text,
            }],
            ...(at !== undefined ? { at } : {}),
          })
        }
        continue
      }
      if (role !== 'user' && role !== 'assistant') throw new Error(`Command Code message role ${String(role)} is not supported.`)
    }
    const updatedAt = messages.at(-1)?.at ?? fileMtime
    return {
      messages,
      nativeSessionId,
      preview: previewOf(messages),
      messageCount: countMessages(messages),
      updatedAt,
    }
  }
}
