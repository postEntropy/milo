import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ChatRequest, Provider, StreamEvent, ToolResultPart } from '../src/core/providers/types.js'
import { ctxFor, makeDir, makeTree } from './tree.js'

// A throwaway home, set before anything that reads MILO_HOME is loaded: these
// tests put pictures on disk, and the real `~/.milo/images` belongs to the person.
const home = mkdtempSync(path.join(tmpdir(), 'milo-view-image-'))
process.env.MILO_HOME = home

const { runAgent } = await import('../src/core/agent/loop.js')
const { toolImages } = await import('../src/core/images.js')
const { ToolRegistry } = await import('../src/core/tools/registry.js')
const { viewImageTool } = await import('../src/core/tools/view-image.js')

afterAll(() => rmSync(home, { recursive: true, force: true }))

/** The first bytes of a png: enough for the bytes to be the ones that come back. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x2a])

/** Replays a fixed script and keeps the last request it was handed. */
class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  calls = 0
  last?: ChatRequest

  constructor(private readonly scripts: StreamEvent[][]) {}

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.last = req
    const script = this.scripts[this.calls] ?? [{ type: 'done' as const, finishReason: 'stop' as const }]
    this.calls += 1
    for (const event of script) yield event
  }
}

describe('view_image', () => {
  it('hands the picture back as an image part, byte for byte', async () => {
    const tree = makeTree({ 'shot.png': PNG })
    try {
      const result = await viewImageTool.execute({ path: 'shot.png' }, ctxFor(tree.root))
      expect(result.isError).toBeUndefined()
      expect(result.content).toBe('Looking at shot.png.')
      expect(result.images).toEqual([{ mimeType: 'image/png', data: PNG.toString('base64') }])
    } finally {
      tree.cleanup()
    }
  })

  it('takes a jpeg too, reading the type from the extension', async () => {
    const tree = makeTree({ 'photo.JPG': PNG })
    try {
      const result = await viewImageTool.execute({ path: 'photo.JPG' }, ctxFor(tree.root))
      expect(result.images).toEqual([{ mimeType: 'image/jpeg', data: PNG.toString('base64') }])
    } finally {
      tree.cleanup()
    }
  })

  it('names the type when it cannot show one', async () => {
    const tree = makeTree({ 'anim.gif': PNG })
    try {
      const result = await viewImageTool.execute({ path: 'anim.gif' }, ctxFor(tree.root))
      expect(result.isError).toBe(true)
      expect(result.content).toContain('image/gif')
      expect(result.content).toContain('png or a jpeg')
      expect(result.images).toBeUndefined()
    } finally {
      tree.cleanup()
    }
  })

  it('refuses a directory', async () => {
    const tree = makeTree({})
    try {
      makeDir(tree.root, 'pictures')
      const result = await viewImageTool.execute({ path: 'pictures' }, ctxFor(tree.root))
      expect(result.isError).toBe(true)
      expect(result.content).toBe('pictures is a directory, not a picture.')
    } finally {
      tree.cleanup()
    }
  })

  it('says a file that is not there could not be looked at', async () => {
    const tree = makeTree({})
    try {
      const result = await viewImageTool.execute({ path: 'gone.png' }, ctxFor(tree.root))
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Could not look at gone.png')
    } finally {
      tree.cleanup()
    }
  })

  it('carries the picture, from disk, into the request the next step is sent', async () => {
    const tree = makeTree({ 'shot.png': PNG })
    try {
      const registry = new ToolRegistry([viewImageTool])
      const provider = new ScriptedProvider([
        [
          { type: 'tool-call', id: 'c1', name: 'view_image', args: { path: 'shot.png' } },
          { type: 'done', finishReason: 'tool_calls' },
        ],
        [
          { type: 'text', delta: 'A terminal with a red banner.' },
          { type: 'done', finishReason: 'stop' },
        ],
      ])

      for await (const _event of runAgent({
        provider,
        model: 'm',
        tools: registry.specs(),
        registry,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'what is on screen?' }] }],
        context: { cwd: tree.root, signal: new AbortController().signal },
        maxSteps: 3,
      })) {
        // Drained: what this test reads is the request the second step was handed.
      }

      const tool = provider.last?.messages.find((message) => message.role === 'tool')
      const part = tool?.content[0] as ToolResultPart
      expect(part.name).toBe('view_image')
      expect(toolImages(part)).toEqual({
        text: 'Looking at shot.png.',
        images: [{ mimeType: 'image/png', data: PNG.toString('base64') }],
      })
    } finally {
      tree.cleanup()
    }
  })
})
