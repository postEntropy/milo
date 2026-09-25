import { parseSSE } from './sse.js'
import { errorMessage } from '../../util/errors.js'
import { logDebug } from '../../util/log.js'
import { toolImages } from '../images.js'
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

export interface AnthropicProviderOptions {
  id: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

interface Block {
  kind: 'text' | 'tool'
  id?: string
  name?: string
  json: string
}

interface AnthropicStreamEvent {
  type?: string
  index: number
  message?: { usage?: { input_tokens?: number } }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: { output_tokens?: number }
  error?: { message?: string }
}

const DEFAULT_MAX_TOKENS = 4096
const ANTHROPIC_VERSION = '2023-06-01'

export class AnthropicProvider implements Provider {
  readonly id: string
  private readonly baseURL: string
  private readonly apiKey?: string
  private readonly headers: Record<string, string>

  constructor(options: AnthropicProviderOptions) {
    this.id = options.id
    this.baseURL = options.baseURL.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.headers = options.headers ?? {}
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      messages: await toAnthropicMessages(req.messages),
    }
    if (req.system) body.system = req.system
    if (req.tools?.length) body.tools = req.tools.map(toAnthropicTool)
    if (typeof req.temperature === 'number') body.temperature = req.temperature

    const response = await fetch(`${this.baseURL}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        ...(this.apiKey ? { 'x-api-key': this.apiKey } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok || !response.body) {
      throw new Error(await httpError(response))
    }

    const blocks = new Map<number, Block>()
    let finish: FinishReason = 'stop'
    let contentChars = 0
    let reasoningChars = 0
    let inputTokens = 0

    for await (const message of parseSSE(response.body)) {
      let event: AnthropicStreamEvent
      try {
        event = JSON.parse(message.data) as AnthropicStreamEvent
      } catch (error) {
        logDebug(`anthropic: skipped an unparseable stream chunk: ${errorMessage(error)}`)
        continue
      }

      switch (event.type) {
        case 'message_start': {
          inputTokens = event.message?.usage?.input_tokens ?? 0
          break
        }
        case 'content_block_start': {
          const block = event.content_block
          if (block?.type === 'tool_use') {
            blocks.set(event.index, { kind: 'tool', id: block.id, name: block.name, json: '' })
          } else {
            blocks.set(event.index, { kind: 'text', json: '' })
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta?.type === 'text_delta' && delta.text) {
            contentChars += delta.text.length
            yield { type: 'text', delta: delta.text }
          } else if (delta?.type === 'thinking_delta' && delta.thinking) {
            reasoningChars += delta.thinking.length
            yield { type: 'reasoning', delta: delta.thinking }
          } else if (delta?.type === 'input_json_delta') {
            const block = blocks.get(event.index)
            if (block) block.json += delta.partial_json ?? ''
          }
          break
        }
        case 'content_block_stop': {
          const block = blocks.get(event.index)
          if (block?.kind === 'tool') {
            yield {
              type: 'tool-call',
              id: block.id ?? `call_${event.index}`,
              name: block.name ?? '',
              args: parseToolArgs(block.json),
            }
          }
          break
        }
        case 'message_delta': {
          const stop = event.delta?.stop_reason
          if (stop) finish = mapStopReason(stop)
          const outputTokens = event.usage?.output_tokens
          if (typeof outputTokens === 'number') {
            yield { type: 'usage', inputTokens, outputTokens }
          }
          break
        }
        case 'error': {
          throw new Error(event.error?.message ?? 'anthropic stream error')
        }
        default:
          break
      }
    }

    // A provider that puts both channels in one field is indistinguishable from a
    // model that answered in its thinking, unless the counts are written down:
    // content 0 with reasoning full is that quirk, not a model that said nothing.
    logDebug(
      `anthropic: ${contentChars} chars of content, ${reasoningChars} chars of reasoning, finished ${finish}`,
    )

    yield { type: 'done', finishReason: finish }
  }
}

function toAnthropicTool(spec: ToolSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }
}

async function toAnthropicMessages(messages: Message[]): Promise<unknown[]> {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = []

  const push = (role: 'user' | 'assistant', blocks: unknown[]) => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content.push(...blocks)
    } else {
      out.push({ role, content: blocks })
    }
  }

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      const blocks = message.content
        .filter((part) => part.type === 'tool-result')
        .map((part) => toolResultBlock(part as ToolResultPart))
      push('user', blocks)
      continue
    }

    const blocks: unknown[] = []
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'tool-call') {
        blocks.push({
          type: 'tool_use',
          id: part.id,
          name: part.name,
          input: part.args ?? {},
        })
      }
    }
    push(message.role === 'assistant' ? 'assistant' : 'user', blocks)
  }

  return out
}

/**
 * A tool result carrying pictures becomes an array of blocks — the text, then
 * one base64 image each — while a plain result stays the string it always was.
 * Anthropic has no `image_url`; the bytes go inline as `source.type: base64`.
 */
function toolResultBlock(part: ToolResultPart): Record<string, unknown> {
  const { text, images } = toolImages(part)
  const content =
    images.length === 0
      ? text
      : [
          { type: 'text', text },
          ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: image.data },
          })),
        ]

  return {
    type: 'tool_result',
    tool_use_id: part.id,
    content,
    ...(part.isError ? { is_error: true } : {}),
  }
}

function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    default:
      return 'stop'
  }
}

async function httpError(response: Response): Promise<string> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 500)
  } catch {
    // ignore
  }
  return `Provider request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`
}
