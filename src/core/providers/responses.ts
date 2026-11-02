import { parseSSE } from './sse.js'
import { fetchWithRetry } from './retry.js'
import { errorMessage } from '../../util/errors.js'
import { logDebug, logWarn } from '../../util/log.js'
import { readImageBase64, toolImages } from '../images.js'
import { clampOutput, outputTokenCap, readFailure } from './failure.js'
import {
  parseToolArgs,
  type ChatRequest,
  type FinishReason,
  type Message,
  type Provider,
  type StreamEvent,
  type ToolResultPart,
  type ToolSpec,
} from './types.js'

/** What the wire needs before it can send a request: a bearer token, and the account it belongs to. */
export interface ResponsesAccess {
  token: string
  accountId?: string
}

export interface ResponsesProviderOptions {
  id: string
  baseURL: string
  apiKey?: string
  /** A token source used instead of a fixed key. `force` asks for a refresh after a 401. */
  token?: (force?: boolean) => Promise<ResponsesAccess>
  headers?: Record<string, string>
  /** Told the ceiling a refusal named, so the run after it need not learn it again. */
  onOutputCap?: (tokens: number) => void | Promise<void>
}

interface PendingCall {
  name?: string
  arguments: string
}

interface ResponseItem {
  id?: string
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  encrypted_content?: string
  summary?: unknown
  content?: unknown
}

interface ResponsePayload {
  status?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
  incomplete_details?: { reason?: string }
  output?: ResponseItem[]
}

interface ResponsesStreamEvent {
  type?: string
  delta?: string
  item_id?: string
  item?: ResponseItem
  response?: ResponsePayload
  error?: { message?: string }
  message?: string
}

/**
 * The OpenAI Responses wire, which is what the ChatGPT backend speaks. It differs
 * from `/chat/completions` in three ways that matter here: the system prompt is
 * `instructions`, the transcript is a list of typed items rather than roles with
 * `content`, and a reasoning item must be replayed with its encrypted content —
 * which is kept on the reasoning part's `signature`.
 */
export class ResponsesProvider implements Provider {
  readonly id: string
  private readonly baseURL: string
  private readonly apiKey?: string
  private readonly token?: (force?: boolean) => Promise<ResponsesAccess>
  private readonly headers: Record<string, string>
  private maxTokensCap?: number
  private readonly onOutputCap?: (tokens: number) => void | Promise<void>

  constructor(options: ResponsesProviderOptions) {
    this.id = options.id
    this.baseURL = options.baseURL.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.token = options.token
    this.headers = options.headers ?? {}
    this.onOutputCap = options.onOutputCap
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    let access = await this.access()
    let body = await this.buildBody(req)
    let response = await this.send(body, access, req.signal)

    // A token can be revoked between turns; asking once with a fresh one is the
    // difference between a working grant and a sign-in nobody knows is needed.
    if (response.status === 401 && this.token) {
      access = await this.token(true)
      response = await this.send(body, access, req.signal)
    }

    if (!response.ok) {
      let failure = await readFailure(response)
      // A catalog can declare another route's ceiling; the server's own word is
      // the one that holds. Ask once with it, then keep it.
      const cap = response.status === 400 ? outputTokenCap(failure.detail) : undefined
      if (cap === undefined) throw new Error(failure.message)
      this.maxTokensCap = cap
      await this.onOutputCap?.(cap)
      logWarn(
        `provider ${this.id} refused max_output_tokens=${String(body.max_output_tokens)} and accepts at most ${cap}; asking again with that`,
      )
      body = { ...body, max_output_tokens: cap }
      response = await this.send(body, access, req.signal)
      if (!response.ok) {
        failure = await readFailure(response)
        throw new Error(failure.message)
      }
    }

    if (!response.body) {
      throw new Error(`Provider request failed (${response.status} ${response.statusText})`)
    }

    const pending = new Map<string, PendingCall>()
    const emitted = new Set<string>()
    let finished = false
    let finish: FinishReason = 'stop'
    let sawTool = false
    let contentChars = 0
    let reasoningChars = 0

    for await (const message of parseSSE(response.body)) {
      if (message.data === '[DONE]') {
        finished = true
        break
      }

      let event: ResponsesStreamEvent
      try {
        event = JSON.parse(message.data) as ResponsesStreamEvent
      } catch (error) {
        logDebug(`responses: skipped an unparseable stream chunk: ${errorMessage(error)}`)
        continue
      }

      switch (event.type) {
        case 'error': {
          throw new Error(event.message ?? event.error?.message ?? 'provider error')
        }
        case 'response.failed': {
          throw new Error(event.response?.error?.message ?? 'the provider failed the response')
        }
        case 'response.output_text.delta':
        case 'response.refusal.delta': {
          if (typeof event.delta === 'string' && event.delta) {
            contentChars += event.delta.length
            yield { type: 'text', delta: event.delta }
          }
          break
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (typeof event.delta === 'string' && event.delta) {
            reasoningChars += event.delta.length
            yield { type: 'reasoning', delta: event.delta }
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const key = event.item_id ?? event.item?.id ?? ''
          const current = pending.get(key) ?? { arguments: '' }
          if (typeof event.delta === 'string') current.arguments += event.delta
          pending.set(key, current)
          break
        }
        case 'response.function_call_arguments.done': {
          const key = event.item_id ?? event.item?.id ?? ''
          const current = pending.get(key) ?? { arguments: '' }
          if (typeof event.delta === 'string') current.arguments = event.delta
          pending.set(key, current)
          break
        }
        case 'response.output_item.added': {
          const item = event.item
          if (item?.type === 'function_call' && item.id) {
            pending.set(item.id, {
              name: item.name,
              arguments: typeof item.arguments === 'string' ? item.arguments : '',
            })
          }
          break
        }
        case 'response.output_item.done': {
          if (event.item) {
            for (const outgoing of itemEvents(
              event.item,
              pending,
              emitted,
              contentChars === 0,
              reasoningChars === 0,
            )) {
              if (outgoing.type === 'text') contentChars += outgoing.delta.length
              if (outgoing.type === 'reasoning') reasoningChars += outgoing.delta.length
              if (outgoing.type === 'tool-call') sawTool = true
              yield outgoing
            }
          }
          break
        }
        case 'response.completed':
        case 'response.incomplete': {
          finished = true
          const payload = event.response
          if (payload?.usage) {
            yield {
              type: 'usage',
              inputTokens: payload.usage.input_tokens ?? 0,
              outputTokens: payload.usage.output_tokens ?? 0,
            }
          }
          if (payload?.status === 'incomplete' && payload.incomplete_details?.reason === 'max_output_tokens') {
            finish = 'length'
          }
          // Some servers send no per-item events, only the finished response.
          for (const item of payload?.output ?? []) {
            for (const outgoing of itemEvents(
              item,
              pending,
              emitted,
              contentChars === 0,
              reasoningChars === 0,
            )) {
              if (outgoing.type === 'text') contentChars += outgoing.delta.length
              if (outgoing.type === 'reasoning') reasoningChars += outgoing.delta.length
              if (outgoing.type === 'tool-call') sawTool = true
              yield outgoing
            }
          }
          break
        }
        default:
          break
      }
    }

    if (!finished) {
      throw new Error('the provider stream ended before the message was complete')
    }

    if (sawTool && finish === 'stop') finish = 'tool_calls'

    logDebug(
      `responses: ${contentChars} chars of content, ${reasoningChars} chars of reasoning, finished ${finish}`,
    )

    yield { type: 'done', finishReason: finish }
  }

  private async access(): Promise<ResponsesAccess> {
    if (this.token) return this.token(false)
    if (this.apiKey) return { token: this.apiKey }
    throw new Error(`Provider "${this.id}" is not signed in.`)
  }

  private async buildBody(req: ChatRequest): Promise<Record<string, unknown>> {
    const { instructions, input } = await toResponsesInput(req.system, req.messages)
    const maxTokens = clampOutput(req.maxTokens, this.maxTokensCap)
    const body: Record<string, unknown> = {
      model: req.model,
      input,
      stream: true,
      // The backend keeps no thread for us: every request replays its transcript,
      // which is also why reasoning comes back encrypted.
      store: false,
      include: ['reasoning.encrypted_content'],
    }
    if (instructions) body.instructions = instructions
    if (req.tools?.length) {
      body.tools = req.tools.map(toResponsesTool)
      body.tool_choice = 'auto'
      body.parallel_tool_calls = true
    }
    // A reasoning model refuses a sampling temperature; the Responses wire only
    // takes one when the model is not thinking.
    if (typeof req.temperature === 'number' && !req.reasoningEffort) body.temperature = req.temperature
    if (typeof maxTokens === 'number') body.max_output_tokens = maxTokens
    if (req.reasoningEffort) {
      body.reasoning = { effort: req.reasoningEffort, summary: 'auto' }
    }
    return body
  }

  private send(body: Record<string, unknown>, access: ResponsesAccess, signal?: AbortSignal): Promise<Response> {
    return fetchWithRetry(
      `${this.baseURL}/responses`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${access.token}`,
          ...(access.accountId
            ? { 'chatgpt-account-id': access.accountId, originator: 'codex_cli_rs' }
            : {}),
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal,
      },
      { signal },
    )
  }
}

/** The items one finished output node becomes. Ordered as the model emitted them. */
function itemEvents(
  item: ResponseItem,
  pending: Map<string, PendingCall>,
  emitted: Set<string>,
  noTextYet: boolean,
  noReasoningYet: boolean,
): StreamEvent[] {
  const out: StreamEvent[] = []

  if (item.type === 'function_call') {
    const id = item.call_id ?? item.id ?? ''
    if (id && !emitted.has(id)) {
      emitted.add(id)
      const streamed = item.id ? pending.get(item.id) : undefined
      const args = typeof item.arguments === 'string' ? item.arguments : (streamed?.arguments ?? '')
      out.push({
        type: 'tool-call',
        id,
        name: item.name ?? streamed?.name ?? '',
        args: parseToolArgs(args),
      })
    }
    return out
  }

  if (item.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content) {
    const key = `reasoning:${item.id ?? item.encrypted_content}`
    if (!emitted.has(key)) {
      emitted.add(key)
      out.push({
        type: 'reasoning-signature',
        signature: JSON.stringify({
          ...(item.id ? { id: item.id } : {}),
          encrypted_content: item.encrypted_content,
          summary: Array.isArray(item.summary) ? item.summary : [],
        }),
      })
    }
    if (noReasoningYet && Array.isArray(item.summary)) {
      const summary = item.summary
        .map((part) =>
          part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
        )
        .join('')
      if (summary) out.push({ type: 'reasoning', delta: summary })
    }
    return out
  }

  if (noTextYet && (item.type === 'message' || item.type === 'output_text' || item.type === 'refusal')) {
    const text = outputText(item)
    if (text) out.push({ type: 'text', delta: text })
  }

  return out
}

function outputText(item: ResponseItem): string {
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const record = part as { type?: unknown; text?: unknown; refusal?: unknown }
      if (typeof record.text === 'string') return record.text
      if (typeof record.refusal === 'string') return record.refusal
      return ''
    })
    .join('')
}

async function toResponsesInput(
  system: string | undefined,
  messages: Message[],
): Promise<{ instructions?: string; input: unknown[] }> {
  const input: unknown[] = []

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') input.push(functionCallOutput(part))
      }
      continue
    }

    if (message.role === 'assistant') {
      let text = ''
      const flush = (): void => {
        if (text) input.push({ role: 'assistant', content: text })
        text = ''
      }
      for (const part of message.content) {
        if (part.type === 'text') {
          text += part.text
        } else if (part.type === 'reasoning') {
          flush()
          const replay = reasoningReplay(part.signature)
          if (replay) input.push(replay)
        } else if (part.type === 'tool-call') {
          flush()
          input.push({
            type: 'function_call',
            call_id: part.id,
            name: part.name,
            arguments: JSON.stringify(part.args ?? {}),
          })
        }
      }
      flush()
      continue
    }

    const parts: unknown[] = []
    let missingImages = 0
    let missingAudio = 0
    for (const part of message.content) {
      if (part.type === 'text') {
        parts.push({ type: 'input_text', text: part.text })
      } else if (part.type === 'image') {
        const data = readImageBase64(part)
        if (data) {
          parts.push({ type: 'input_image', image_url: `data:${part.mimeType};base64,${data}` })
        } else {
          missingImages += 1
        }
      } else if (part.type === 'audio') {
        missingAudio += 1
      }
    }
    if (missingImages > 0) {
      parts.push({ type: 'input_text', text: `[${missingImages} attached image(s) are unavailable]` })
    }
    if (missingAudio > 0) {
      parts.push({ type: 'input_text', text: `[${missingAudio} attached audio file(s) are unavailable]` })
    }
    input.push({ role: message.role, content: parts.length > 0 ? parts : '' })
  }

  return { ...(system ? { instructions: system } : {}), input }
}

/** A signed thought comes back as the item the backend issued, encrypted content included. */
function reasoningReplay(signature: string | undefined): Record<string, unknown> | undefined {
  if (!signature) return undefined
  try {
    const parsed: unknown = JSON.parse(signature)
    if (!parsed || typeof parsed !== 'object') return undefined
    const record = parsed as { id?: unknown; encrypted_content?: unknown; summary?: unknown }
    if (typeof record.encrypted_content !== 'string' || !record.encrypted_content) return undefined
    return {
      type: 'reasoning',
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
      encrypted_content: record.encrypted_content,
      summary: Array.isArray(record.summary) ? record.summary : [],
    }
  } catch {
    return undefined
  }
}

function functionCallOutput(part: ToolResultPart): Record<string, unknown> {
  const { text, images } = toolImages(part)
  if (images.length === 0) {
    return { type: 'function_call_output', call_id: part.id, output: text }
  }
  return {
    type: 'function_call_output',
    call_id: part.id,
    output: [
      { type: 'input_text', text },
      ...images.map((image) => ({
        type: 'input_image',
        image_url: `data:${image.mimeType};base64,${image.data}`,
      })),
    ],
  }
}

function toResponsesTool(spec: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    strict: false,
  }
}
