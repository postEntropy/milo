import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ChatRequest, Message, Provider, StreamEvent } from '../src/core/providers/types.js'
import type { Tool } from '../src/core/tools/types.js'

// Point the app at a throwaway home *before* the modules that read it load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-images-'))
process.env.MILO_HOME = home

// Everything below is imported after the home is pointed at a throwaway
// directory: a static import would be hoisted above the line that sets it and
// read the real one, writing into and pruning the person's own images.
const { runAgent } = await import('../src/core/agent/loop.js')
const { imagesDir } = await import('../src/core/config/paths.js')
const { IMAGE_TOKENS, pruneImages, saveImage, toolImages } = await import('../src/core/images.js')
const { ToolRegistry } = await import('../src/core/tools/registry.js')
const { AnthropicProvider } = await import('../src/core/providers/anthropic.js')
const { OpenAIProvider } = await import('../src/core/providers/openai.js')
const { dropOldAudio, dropOldImages, estimateTokens } = await import('../src/core/sessions/compact.js')

const PNG = 'aGVsbG8=' // "hello", enough for a file

/**
 * The tool in these fixtures, which is a stand-in on purpose: nothing shipped
 * returns a picture right now, and the subject here is the plumbing a tool that
 * does would travel through — the file on disk, the reference in the transcript,
 * and the base64 the wires get back.
 */
const IMAGE_TOOL = 'picture_tool'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('saveImage', () => {
  it('writes the bytes and hands back where they went', async () => {
    const ref = await saveImage({ mimeType: 'image/png', data: PNG })

    expect(ref).not.toBeNull()
    expect(ref?.path.startsWith(imagesDir())).toBe(true)
    expect(readFileSync(ref!.path).toString('base64')).toBe(PNG)
  })

  it('keeps the same picture once, however many times it is captured', async () => {
    // A picture no other test in this file writes, so what lands in the cache is
    // this test's own doing — and the cache itself is shared, so what was there
    // before is counted separately rather than assumed away.
    const before = new Set(readdirSync(imagesDir()))
    const fresh = Buffer.from('one screenshot, captured twice').toString('base64')
    const first = await saveImage({ mimeType: 'image/png', data: fresh })
    const second = await saveImage({ mimeType: 'image/png', data: fresh })

    expect(second?.path).toBe(first?.path)
    expect(readdirSync(imagesDir()).filter((name) => !before.has(name))).toHaveLength(1)
  })

  it('says nothing rather than keeping an empty picture', async () => {
    expect(await saveImage({ mimeType: 'image/png', data: '' })).toBeNull()
  })

  it('drops the least recently saved beyond the limit', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'milo-prune-'))
    const names = ['a', 'b', 'c'].map((name) => path.join(dir, `${name}.png`))
    for (const name of names) writeFileSync(name, 'x')

    pruneImages(0) // nothing is kept: every picture in the home goes
    expect(readdirSync(imagesDir()).length).toBe(0)
  })
})

describe('toolImages', () => {
  it('reads the picture back for the request', async () => {
    const ref = await saveImage({ mimeType: 'image/jpeg', data: PNG })
    const { text, images } = toolImages({ content: 'clicked', images: [ref!] })

    expect(text).toBe('clicked')
    expect(images).toEqual([{ mimeType: 'image/jpeg', data: PNG }])
  })

  it('notes a picture that is gone instead of pretending it arrived', async () => {
    const ref = await saveImage({ mimeType: 'image/png', data: PNG })
    const { text, images } = toolImages({
      content: 'clicked',
      images: [ref!, { mimeType: 'image/png', path: path.join(imagesDir(), 'gone.png') }],
    })

    expect(images).toHaveLength(1)
    expect(text).toContain('1 screenshot(s) no longer available')
  })

  it('leaves a result with no pictures exactly as it was', () => {
    expect(toolImages({ content: 'plain' })).toEqual({ text: 'plain', images: [] })
  })
})

describe('estimateTokens', () => {
  it('counts a picture by the pixel, not by its base64 length', () => {
    const withImage = estimateTokens([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'c1',
            name: IMAGE_TOOL,
            content: 'screen',
            images: [{ mimeType: 'image/png', path: '/x/y.png' }],
          },
        ],
      },
    ])

    expect(withImage).toBe(Math.ceil('screen'.length / 4) + IMAGE_TOKENS)
  })
})

describe('dropOldImages', () => {
  const resultWith = (id: string) => ({
    role: 'tool' as const,
    content: [
      {
        type: 'tool-result' as const,
        id,
        name: IMAGE_TOOL,
        content: `shot ${id}`,
        images: [{ mimeType: 'image/png' as const, path: `/img/${id}.png` }],
      },
    ],
  })

  it('keeps the most recent few and says so where the others were', () => {
    const messages: Message[] = ['a', 'b', 'c', 'd', 'e', 'f'].map(resultWith)
    dropOldImages(messages, 2)

    expect(messages[4]!.content[0]).toMatchObject({ images: [{ path: '/img/e.png' }] })
    expect(messages[5]!.content[0]).toMatchObject({ images: [{ path: '/img/f.png' }] })
    const dropped = messages[3]!.content[0] as { images?: unknown; content: string }
    expect(dropped.images).toBeUndefined()
    expect(dropped.content).toContain('screenshot dropped')
  })

  it('is idempotent, so the note is not appended twice', () => {
    const messages: Message[] = ['a', 'b', 'c'].map(resultWith)
    dropOldImages(messages, 1)
    const after = (messages[0]!.content[0] as { content: string }).content
    dropOldImages(messages, 1)

    expect((messages[0]!.content[0] as { content: string }).content).toBe(after)
  })

  it('keeps recent incoming pictures and leaves a note for older ones', () => {
    const messages: Message[] = ['a', 'b', 'c'].map((name) => ({
      role: 'user', content: [
        { type: 'text', text: `look at ${name}` },
        { type: 'image', mimeType: 'image/png', path: `/img/${name}.png`, name: `${name}.png` },
      ],
    }))
    dropOldImages(messages, 2)

    expect(messages[0]!.content).toContainEqual({ type: 'text', text: '[Image a.png omitted to keep the request small]' })
    expect(messages[1]!.content.some((part) => part.type === 'image')).toBe(true)
    expect(messages[2]!.content.some((part) => part.type === 'image')).toBe(true)
  })

  it('keeps only the newest audio clip in the request history', () => {
    const messages: Message[] = ['a', 'b'].map((name) => ({
      role: 'user', content: [
        { type: 'text', text: `listen to ${name}` },
        { type: 'audio', mimeType: 'audio/wav', path: `/audio/${name}.wav`, name: `${name}.wav` },
      ],
    }))
    dropOldAudio(messages)
    expect(messages[0]!.content).toContainEqual({ type: 'text', text: '[Audio a.wav omitted to keep the request small]' })
    expect(messages[1]!.content.some((part) => part.type === 'audio')).toBe(true)
    expect(estimateTokens([messages[1]!])).toBeGreaterThan(1_000)
  })
})

/** A provider whose only job is to capture the request it was handed. */
class CapturingProvider implements Provider {
  readonly id = 'capturing'
  last?: ChatRequest
  constructor(private readonly inner: Provider) {}
  stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.last = req
    return this.inner.stream(req)
  }
}

const sse = (chunks: string[]) => {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

const stubStream = (chunks: string[]) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(sse(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    ),
  )
}

describe('the wires', () => {
  it('sends an incoming picture with the user message on the OpenAI wire', async () => {
    const ref = await saveImage({ mimeType: 'image/png', data: PNG })
    stubStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
    const provider = new CapturingProvider(new OpenAIProvider({ id: 'test', baseURL: 'https://x.test/v1' }))
    for await (const _event of provider.stream({
      model: 'm',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', mimeType: 'image/png', path: ref!.path, name: 'photo.png' },
      ] }],
    })) { /* drain */ }
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {
      messages: { role: string; content: unknown }[]
    }
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ])
  })

  it('sends native audio with the user message on the OpenAI wire', async () => {
    const audioPath = path.join(home, 'voice.wav')
    writeFileSync(audioPath, Buffer.from('audio bytes'))
    stubStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
    const provider = new CapturingProvider(new OpenAIProvider({ id: 'test', baseURL: 'https://x.test/v1' }))
    for await (const _event of provider.stream({
      model: 'm',
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Transcribe this.' },
        { type: 'audio', mimeType: 'audio/wav', path: audioPath, name: 'voice.wav' },
      ] }],
    })) { /* drain */ }
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {
      messages: { role: string; content: unknown }[]
    }
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: 'Transcribe this.' },
      { type: 'input_audio', input_audio: { data: Buffer.from('audio bytes').toString('base64'), format: 'wav' } },
    ])
  })

  it('sends the picture with the tool result on the OpenAI wire', async () => {
    const ref = await saveImage({ mimeType: 'image/png', data: PNG })
    stubStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
    const inner = new OpenAIProvider({ id: 'test', baseURL: 'https://x.test/v1' })
    const provider = new CapturingProvider(inner)

    for await (const _event of provider.stream({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }] },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              id: 'c1',
              name: IMAGE_TOOL,
              content: 'the screen',
              images: [ref!],
            },
          ],
        },
      ],
    })) {
      // drain — the request body is what this test is about
    }

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {
      messages: { role: string; content: unknown }[]
    }
    const tool = body.messages.find((message) => message.role === 'tool')
    expect(tool?.content).toEqual([
      { type: 'text', text: 'the screen' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    ])
  })

  it('leaves a plain tool result a plain string', async () => {
    stubStream(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n'])
    const inner = new OpenAIProvider({ id: 'test', baseURL: 'https://x.test/v1' })
    const provider = new CapturingProvider(inner)

    for await (const _event of provider.stream({
      model: 'm',
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool-result', id: 'c1', name: 'read_file', content: 'a file' }],
        },
      ],
    })) {
      // drain
    }

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {
      messages: { role: string; content: unknown }[]
    }
    // A great many OpenAI-compatible servers reject the array shape, and none of
    // them need it to read text.
    expect(body.messages.find((message) => message.role === 'tool')?.content).toBe('a file')
  })

  it('sends the picture as a tool_result image block on the Anthropic wire', async () => {
    const ref = await saveImage({ mimeType: 'image/jpeg', data: PNG })
    stubStream(['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'])
    const provider = new CapturingProvider(
      new AnthropicProvider({ id: 'test', baseURL: 'https://a.test/v1' }),
    )

    for await (const _event of provider.stream({
      model: 'claude-test',
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              id: 'toolu_1',
              name: IMAGE_TOOL,
              content: 'the screen',
              images: [ref!],
            },
          ],
        },
      ],
    })) {
      // drain
    }

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)) as {
      messages: { role: string; content: { type: string; content?: unknown }[] }[]
    }
    const block = body.messages[0]?.content[0]
    expect(block?.type).toBe('tool_result')
    expect(block?.content).toEqual([
      { type: 'text', text: 'the screen' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } },
    ])
  })
})

/** The loop is what turns a tool's bytes into a reference in the transcript. */
class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  private calls = 0
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    const script = this.scripts[this.calls] ?? [{ type: 'done', finishReason: 'stop' }]
    this.calls += 1
    for (const event of script) yield event
  }
}

describe('the loop', () => {
  it('puts a tool’s picture on disk and a reference in the transcript', async () => {
    const shot: Tool<Record<string, never>> = {
      name: IMAGE_TOOL,
      description: 'fake capture',
      schema: z.object({}),
      readOnly: true,
      async execute() {
        return { content: 'the screen', images: [{ mimeType: 'image/png', data: PNG }] }
      },
    }
    const registry = new ToolRegistry([shot])
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'look' }] }]
    const provider = new ScriptedProvider([
      [
        { type: 'tool-call', id: 'c1', name: IMAGE_TOOL, args: {} },
        { type: 'done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text', delta: 'done' },
        { type: 'done', finishReason: 'stop' },
      ],
    ])

    for await (const _event of runAgent({
      provider,
      model: 'm',
      tools: registry.specs(),
      registry,
      messages,
      context: { cwd: process.cwd(), signal: new AbortController().signal },
    })) {
      // drain
    }

    const part = messages[2]?.content[0]
    expect(part?.type).toBe('tool-result')
    const ref = (part as { images?: { path: string }[] }).images?.[0]
    expect(ref).toBeDefined()
    // In the transcript as a path, on disk as bytes: the session file stays
    // small, and the wire can still inline what the model needs to see.
    expect(existsSync(ref!.path)).toBe(true)
    expect(readFileSync(ref!.path).toString('base64')).toBe(PNG)
  })
})
