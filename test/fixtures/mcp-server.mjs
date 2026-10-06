#!/usr/bin/env node
// A stand-in MCP server for the suite. It is deliberately a real subprocess
// speaking real newline-delimited JSON-RPC, because the parts worth testing —
// the era probe, the handshake fallback, the framing, the failure reporting —
// only exist on the other side of a pipe.
//
// MCP_ERA: modern | legacy | refuse-modern   (default modern)
//   modern         answers server/discover
//   legacy         refuses anything before initialize, like a pre-2026 server
//   refuse-modern  answers server/discover with UnsupportedProtocolVersionError
// MCP_TOOLS           JSON array of tool definitions to serve
// MCP_TOOLS_AFTER     JSON array served from the second tools/list on, plus a
//                     tools/list_changed notification after the first
// MCP_PAGES           split the tool list into this many pages
// MCP_BANNER=1        print a line that is not an MCP message first
// MCP_STDERR=text     say this on stderr
// MCP_EXIT_AFTER=init exit(1) right after the initialize reply
// MCP_EXIT_AFTER=list exit(1) right after the first tools/list reply
// MCP_DELAY_MS=n      wait this long before answering anything (a slow boot)
import { createInterface } from 'node:readline'

const era = process.env.MCP_ERA ?? 'modern'
const pageCount = Number(process.env.MCP_PAGES ?? '0')
const version = process.env.MCP_VERSION ?? '2026-07-28'

function parseTools(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const defaultTools = [
  {
    name: 'echo',
    description: 'Echo the arguments back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  { name: 'picture', description: 'Answer with a picture.', inputSchema: { type: 'object', properties: {} } },
]
let tools = parseTools(process.env.MCP_TOOLS, defaultTools)
const toolsAfter = parseTools(process.env.MCP_TOOLS_AFTER, null)
const chunks = pageCount > 1 ? splitInto(tools, pageCount) : [tools]

function splitInto(all, count) {
  const size = Math.ceil(all.length / count)
  return Array.from({ length: count }, (_, index) => all.slice(index * size, (index + 1) * size))
}

if (process.env.MCP_STDERR) process.stderr.write(`${process.env.MCP_STDERR}\n`)
if (process.env.MCP_BANNER === '1') process.stdout.write('this line is not an MCP message\n')

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const bad = (id, code, message, data) =>
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })

const delayMs = Number(process.env.MCP_DELAY_MS ?? '0')
let initialized = false
let listings = 0
/** Set while a tool call is waiting for Milo to answer a request the server made. */
let waitingForReply = null

/** A reply to something this server asked — not a request of its own. */
function onReply(message) {
  if (waitingForReply && message.id === 'server-1') {
    const { callId } = waitingForReply
    waitingForReply = null
    const text = message.error ? `client said: ${message.error.message}` : 'client answered'
    ok(callId, { resultType: 'complete', content: [{ type: 'text', text }] })
  }
}

function listFor(params) {
  listings += 1
  if (listings > 1 && toolsAfter) tools = toolsAfter
  if (pageCount > 1) {
    const index = params?.cursor ? Number(params.cursor) : 0
    const next = index + 1 < chunks.length ? String(index + 1) : undefined
    return { resultType: 'complete', tools: chunks[index] ?? [], ...(next ? { nextCursor: next } : {}) }
  }
  return { resultType: 'complete', tools }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  if (delayMs > 0) {
    setTimeout(() => dispatch(message), delayMs)
    return
  }
  dispatch(message)
})

function dispatch(message) {
  const { id, method, params } = message
  if (method === undefined) {
    onReply(message)
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return

  if (method === 'server/discover') {
    if (era === 'refuse-modern') {
      bad(id, -32022, 'Unsupported protocol version', {
        supported: ['2025-11-25'],
        requested: params?._meta?.['io.modelcontextprotocol/protocolVersion'],
      })
      return
    }
    if (era !== 'modern') {
      bad(id, -32601, 'Method not found')
      return
    }
    ok(id, {
      resultType: 'complete',
      supportedVersions: [version],
      capabilities: { tools: { listChanged: true } },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture', version: '1.0.0' } },
    })
    return
  }

  if (method === 'initialize') {
    if (era === 'modern') {
      // A modern server has no initialize. Refusing here proves the probe took
      // the modern path rather than falling back to a handshake.
      bad(id, -32601, 'Method not found')
      return
    }
    initialized = true
    ok(id, {
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'fixture', version: '1.0.0' },
    })
    if (process.env.MCP_EXIT_AFTER === 'init') process.exit(1)
    return
  }

  if (method === 'tools/list') {
    if (!initialized && era !== 'modern') {
      bad(id, -32002, 'Server not initialized')
      return
    }
    ok(id, listFor(params))
    if (toolsAfter && listings === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
    if (process.env.MCP_EXIT_AFTER === 'list') {
      // Die once the reply has reached the pipe: the caller then sees a server
      // that was working and went away, not one that never answered.
      process.stdout.write('', () => process.exit(1))
    }
    return
  }

  if (method === 'tools/call') {
    if (!initialized && era !== 'modern') {
      bad(id, -32002, 'Server not initialized')
      return
    }
    const name = params?.name
    const meta = params?._meta ? 'yes' : 'no'
    if (name === 'hang') return
    if (name === 'boom') {
      ok(id, { resultType: 'complete', content: [{ type: 'text', text: 'the tool went wrong' }], isError: true })
      return
    }
    if (name === 'input_required') {
      ok(id, { resultType: 'input_required', inputRequests: { who: { method: 'elicitation/create' } } })
      return
    }
    if (name === 'picture') {
      ok(id, {
        resultType: 'complete',
        content: [
          { type: 'image', mimeType: 'image/png', data: 'aGk=' },
          { type: 'image', mimeType: 'image/webp', data: 'aGk=' },
          { type: 'audio', mimeType: 'audio/wav', data: 'aGk=' },
          { type: 'resource_link', uri: 'file:///tmp/a.rs', name: 'a.rs' },
          { type: 'resource', resource: { uri: 'file:///tmp/b.rs', text: 'fn main() {}' } },
          { type: 'mystery', whatever: true },
        ],
      })
      return
    }
    if (name === 'structured') {
      ok(id, { resultType: 'complete', structuredContent: { answer: 42 }, content: [] })
      return
    }
    if (name === 'ask-milo') {
      // A server asking the client for something. The call only finishes once
      // Milo answers, so a client that ignores the request hangs here instead of
      // passing this by accident.
      waitingForReply = { callId: id }
      send({ jsonrpc: '2.0', id: 'server-1', method: 'roots/list' })
      return
    }
    ok(id, {
      resultType: 'complete',
      content: [{ type: 'text', text: `echo ${JSON.stringify(params?.arguments ?? {})} | _meta:${meta}` }],
      isError: false,
    })
    return
  }

  bad(id, -32601, `Method not found: ${method}`)
}
