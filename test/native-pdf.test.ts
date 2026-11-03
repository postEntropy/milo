import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from '../src/core/providers/openai.js'
import { ResponsesProvider } from '../src/core/providers/responses.js'
import { AnthropicProvider } from '../src/core/providers/anthropic.js'
import type { ChatRequest, Provider } from '../src/core/providers/types.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'milo-pdf-wire-'))
const file = path.join(dir, 'report.pdf')
writeFileSync(file, '%PDF-test')
const encoded = Buffer.from('%PDF-test').toString('base64')
const request: ChatRequest = {
  model: 'test', nativePdf: true,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'document', name: 'report.pdf', mimeType: 'application/pdf', path: file }] }],
}

afterEach(() => vi.unstubAllGlobals())

async function bodySent(provider: Provider, input: ChatRequest): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {}
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }))
  for await (const _event of provider.stream(input)) { /* drain */ }
  return body
}

describe('native PDF transport', () => {
  it('sends a PDF file block on Chat Completions', async () => {
    const body = await bodySent(new OpenAIProvider({ id: 'openai', baseURL: 'https://api.openai.com/v1' }), request)
    expect(JSON.stringify(body)).toContain(`data:application/pdf;base64,${encoded}`)
    expect(JSON.stringify(body)).toContain('"type":"file"')
  })

  it('sends an input file on Responses', async () => {
    const body = await bodySent(new ResponsesProvider({ id: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'test' }), request)
    expect(JSON.stringify(body)).toContain('"type":"input_file"')
    expect(JSON.stringify(body)).toContain(`data:application/pdf;base64,${encoded}`)
  })

  it('sends a document block on Anthropic', async () => {
    const body = await bodySent(new AnthropicProvider({ id: 'anthropic', baseURL: 'https://api.anthropic.com/v1' }), request)
    expect(JSON.stringify(body)).toContain('"type":"document"')
    expect(JSON.stringify(body)).toContain(`"data":"${encoded}"`)
  })

  it('leaves the PDF out when native input is disabled', async () => {
    const body = await bodySent(new ResponsesProvider({ id: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'test' }), { ...request, nativePdf: false })
    expect(JSON.stringify(body)).not.toContain(encoded)
    expect(JSON.stringify(body)).not.toContain('input_file')
  })

  it('tells the model when an eligible PDF is unavailable', async () => {
    const missing: ChatRequest = { ...request, messages: [{ role: 'user', content: [{ type: 'document', name: 'gone.pdf', mimeType: 'application/pdf', path: path.join(dir, 'gone.pdf') }] }] }
    const body = await bodySent(new ResponsesProvider({ id: 'openai', baseURL: 'https://api.openai.com/v1', apiKey: 'test' }), missing)
    expect(JSON.stringify(body)).toContain('gone.pdf was not sent as a file')
  })
})
