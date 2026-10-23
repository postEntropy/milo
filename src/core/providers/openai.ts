import { parseSSE } from './sse.js'
import { fetchWithRetry } from './retry.js'
import { errorMessage } from '../../util/errors.js'
import { logDebug, logWarn } from '../../util/log.js'
import { readImageBase64, toolImages } from '../images.js'
import { clampOutput, outputTokenCap, readFailure } from './failure.js'
import { readFileSync } from 'node:fs'
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

export interface OpenAIProviderOptions {
  id: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
  /** Told the ceiling a refusal named, so the run after it need not learn it again. */
  onOutputCap?: (tokens: number) => void | Promise<void>
}

interface PendingToolCall {
  id: string
  name: string
  args: string
}

interface OpenAIDelta {
  content?: string
  reasoning?: string
  reasoning_content?: string
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
}

interface OpenAIStreamChunk {
  error?: { message?: string }
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  choices?: { delta?: OpenAIDelta; finish_reason?: string }[]
}

export class OpenAIProvider implements Provider {
  readonly id: string
  private readonly baseURL: string
  private readonly apiKey?: string
  private readonly headers: Record<string, string>
  /**
   * The most this route said it accepts as `max_tokens`, learned from a refusal.
   * A catalog can declare another route's ceiling; the server's own word is the one
   * that holds for every request after the one that taught it.
   */
  private maxTokensCap?: number
  private readonly onOutputCap?: (tokens: number) => void | Promise<void>

  constructor(options: OpenAIProviderOptions) {
    this.id = options.id
    this.baseURL = options.baseURL.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.headers = options.headers ?? {}
    this.onOutputCap = options.onOutputCap
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const maxTokens = clampOutput(req.maxTokens, this.maxTokensCap)
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: await toOpenAIMessages(req.system, req.messages),
    }
    if (req.tools?.length) {
      body.tools = req.tools.map(toOpenAITool)
      body.tool_choice = 'auto'
    }
    if (typeof req.temperature === 'number') body.temperature = req.temperature
    if (typeof maxTokens === 'number') body.max_tokens = maxTokens
    if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort

    const send = (payload: Record<string, unknown>): Promise<Response> =>
      fetchWithRetry(
        `${this.baseURL}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
            ...this.headers,
          },
          body: JSON.stringify(payload),
          signal: req.signal,
        },
        { signal: req.signal },
      )

    let response = await send(body)
    if (!response.ok) {
      const failure = await readFailure(response)
      // A ceiling a catalog declared may be another route's. When the refusal names
      // the one this route accepts, the request is asked once more with it — and the
      // limit is kept, so the turns after this one start where the server said to.
      const cap = response.status === 400 ? outputTokenCap(failure.detail) : undefined
      if (cap === undefined) throw new Error(failure.message)
      this.maxTokensCap = cap
      await this.onOutputCap?.(cap)
      logWarn(
        `provider ${this.id} refused max_tokens=${String(body.max_tokens)} and accepts at most ${cap}; asking again with that`,
      )
      response = await send({ ...body, max_tokens: cap })
      if (!response.ok) throw new Error((await readFailure(response)).message)
    }

    if (!response.body) {
      throw new Error(`Provider request failed (${response.status} ${response.statusText})`)
    }

    const pending = new Map<number, PendingToolCall>()
    let finish: FinishReason = 'stop'
    // Whether the stream said it was over — `[DONE]`, or a choice that carried a
    // finish reason. A body that ends without either stopped mid-token, and the
    // last words read as a finished answer would hide the cut.
    let finished = false
    let contentChars = 0
    let reasoningChars = 0

    for await (const message of parseSSE(response.body)) {
      if (message.data === '[DONE]') {
        finished = true
        break
      }

      let chunk: OpenAIStreamChunk
      try {
        chunk = JSON.parse(message.data) as OpenAIStreamChunk
      } catch (error) {
        logDebug(`openai: skipped an unparseable stream chunk: ${errorMessage(error)}`)
        continue
      }

      if (chunk.error) throw new Error(chunk.error.message ?? 'provider error')
      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        }
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}

      if (typeof delta.content === 'string' && delta.content) {
        contentChars += delta.content.length
        yield { type: 'text', delta: delta.content }
      }

      // An empty `reasoning_content` is a provider filling the field in, not a
      // thought: taking it would mask a sibling `reasoning` that carries one —
      // which is how a thought goes missing on the wire that looks like it
      // never arrived.
      const reasoning =
        typeof delta.reasoning_content === 'string' && delta.reasoning_content !== ''
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : ''
      if (reasoning) {
        reasoningChars += reasoning.length
        yield { type: 'reasoning', delta: reasoning }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index: number = call.index ?? 0
          const current = pending.get(index) ?? { id: '', name: '', args: '' }
          if (call.id) current.id = call.id
          if (call.function?.name) current.name = call.function.name
          if (call.function?.arguments) current.args += call.function.arguments
          pending.set(index, current)
        }
      }

      if (choice.finish_reason) {
        finish = mapFinishReason(choice.finish_reason)
        finished = true
      }
    }

    if (!finished) {
      throw new Error('the provider stream ended before the message was complete')
    }

    if (pending.size > 0) {
      const ordered = [...pending.entries()].sort((a, b) => a[0] - b[0])
      for (const [index, call] of ordered) {
        yield {
          type: 'tool-call',
          id: call.id || `call_${index}`,
          name: call.name,
          args: parseToolArgs(call.args),
        }
      }
      if (finish === 'stop') finish = 'tool_calls'
    }

    // A provider that puts both channels in one field is indistinguishable from a
    // model that answered in its thinking, unless the counts are written down:
    // content 0 with reasoning full is that quirk, not a model that said nothing.
    logDebug(
      `openai: ${contentChars} chars of content, ${reasoningChars} chars of reasoning, finished ${finish}`,
    )

    yield { type: 'done', finishReason: finish }
  }
}

/**
 * A tool result carrying pictures sends them as `image_url` parts; one without
 * stays the plain string it always was. The array shape is used only when there
 * is a picture to send: a great many OpenAI-compatible servers reject it, and
 * none of them need it to read text.
 */
function toolContent(part: ToolResultPart): unknown {
  const { text, images } = toolImages(part)
  if (images.length === 0) return text
  return [
    { type: 'text', text },
    ...images.map((image) => ({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.data}` },
    })),
  ]
}

function toOpenAITool(spec: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  }
}

async function toOpenAIMessages(system: string | undefined, messages: Message[]): Promise<unknown[]> {
  const out: unknown[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          out.push({ role: 'tool', tool_call_id: part.id, content: toolContent(part) })
        }
      }
      continue
    }

    const images = message.content.flatMap((part) => {
      if (part.type !== 'image') return []
      const data = readImageBase64({ mimeType: part.mimeType, path: part.path })
      return data ? [{ mimeType: part.mimeType, data }] : []
    })
    const missingImages = message.content.filter((part) => part.type === 'image').length - images.length
    const audio = message.content.flatMap((part) => {
      if (part.type !== 'audio') return []
      try {
        const format = part.mimeType === 'audio/wav' || part.mimeType === 'audio/x-wav' ? 'wav' : 'mp3'
        return [{ format, data: readFileSync(part.path).toString('base64') }]
      } catch { return [] }
    })
    const missingAudio = message.content.filter((part) => part.type === 'audio').length - audio.length
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('') + (missingImages ? `\n[${missingImages} attached image(s) are unavailable]` : '')
      + (missingAudio ? `\n[${missingAudio} attached audio file(s) are unavailable]` : '')

    if (message.role === 'assistant') {
      const calls = message.content.filter((part) => part.type === 'tool-call')
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: text || null,
      }
      if (calls.length > 0) {
        entry.tool_calls = calls.map((call) => {
          const c = call as { id: string; name: string; args: unknown }
          return {
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
          }
        })
      }
      out.push(entry)
    } else {
      const parts = [
        ...(text ? [{ type: 'text', text }] : []),
        ...images.map((image) => ({
            type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })),
        ...audio.map((item) => ({ type: 'input_audio', input_audio: { data: item.data, format: item.format } })),
      ]
      out.push({ role: message.role, content: parts.length ? parts : text })
    }
  }

  return out
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'length':
      return 'length'
    default:
      return 'stop'
  }
}
