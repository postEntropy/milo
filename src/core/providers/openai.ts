import { parseSSE } from './sse.js'
import {
  parseToolArgs,
  type ChatRequest,
  type FinishReason,
  type Message,
  type Provider,
  type StreamEvent,
  type ToolSpec,
} from './types.js'

export interface OpenAIProviderOptions {
  id: string
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

interface PendingToolCall {
  id: string
  name: string
  args: string
}

export class OpenAIProvider implements Provider {
  readonly id: string
  private readonly baseURL: string
  private readonly apiKey?: string
  private readonly headers: Record<string, string>

  constructor(options: OpenAIProviderOptions) {
    this.id = options.id
    this.baseURL = options.baseURL.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.headers = options.headers ?? {}
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toOpenAIMessages(req.system, req.messages),
    }
    if (req.tools?.length) {
      body.tools = req.tools.map(toOpenAITool)
      body.tool_choice = 'auto'
    }
    if (typeof req.temperature === 'number') body.temperature = req.temperature
    if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok || !response.body) {
      throw new Error(await httpError(response))
    }

    const pending = new Map<number, PendingToolCall>()
    let finish: FinishReason = 'stop'

    for await (const message of parseSSE(response.body)) {
      if (message.data === '[DONE]') break

      let chunk: any
      try {
        chunk = JSON.parse(message.data)
      } catch {
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
        yield { type: 'text', delta: delta.content }
      }

      const reasoning =
        typeof delta.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string'
            ? delta.reasoning
            : ''
      if (reasoning) yield { type: 'reasoning', delta: reasoning }

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

      if (choice.finish_reason) finish = mapFinishReason(choice.finish_reason)
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

    yield { type: 'done', finishReason: finish }
  }
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

function toOpenAIMessages(system: string | undefined, messages: Message[]): unknown[] {
  const out: unknown[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          out.push({ role: 'tool', tool_call_id: part.id, content: part.content })
        }
      }
      continue
    }

    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('')

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
      out.push({ role: message.role, content: text })
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

async function httpError(response: Response): Promise<string> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, 500)
  } catch {
    // ignore
  }
  return `Provider request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`
}
