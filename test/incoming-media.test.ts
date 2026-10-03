import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const oldHome = process.env.MILO_HOME
const oldGroqKey = process.env.GROQ_API_KEY
process.env.MILO_HOME = mkdtempSync(path.join(tmpdir(), 'milo-incoming-'))
delete process.env.GROQ_API_KEY
const { prepareIncoming } = await import('../src/core/media.js')
const { ConfigSchema } = await import('../src/core/config/schema.js')
const { saveConfig } = await import('../src/core/config/load.js')

function configure(options: { model: string; vision?: string }): void {
  saveConfig(ConfigSchema.parse({
    provider: 'vision-test',
    model: options.model,
    providers: { 'vision-test': { baseURL: 'http://127.0.0.1:43210/v1', keyless: true } },
    media: options.vision ? { vision: options.vision } : undefined,
  }))
}

afterEach(() => {
  if (oldHome === undefined) delete process.env.MILO_HOME
  else process.env.MILO_HOME = oldHome
  if (oldGroqKey === undefined) delete process.env.GROQ_API_KEY
  else process.env.GROQ_API_KEY = oldGroqKey
})

describe('incoming media', () => {
  it('keeps images as disk references and extracts plain text', async () => {
    configure({ model: 'main', vision: 'vision-main' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'vision-main', architecture: { input_modalities: ['text', 'image'] } },
    ] }), { status: 200 })))
    const result = await prepareIncoming([
      { name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') },
      { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello Milo') },
    ])

    expect(result.images).toHaveLength(1)
    expect(readFileSync(result.images[0]!.path).toString()).toBe('image bytes')
    expect(result.text).toEqual(['File notes.txt:\nhello Milo'])
  })

  it('explains that audio needs Groq credentials when no key is set', async () => {
    delete process.env.GROQ_API_KEY
    configure({ model: 'main' })
    delete process.env.GROQ_API_KEY
    const result = await prepareIncoming([
      { name: 'voice.ogg', mimeType: 'audio/ogg', data: Buffer.from('audio bytes') },
    ])
    expect(result.text[0]).toContain('Set GROQ_API_KEY')
  })

  it('keeps supported audio as a disk reference for the selected model', async () => {
    configure({ model: 'audio-main' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'audio-main', architecture: { input_modalities: ['text', 'audio'] } },
    ] }), { status: 200 })))
    const result = await prepareIncoming([
      { name: 'voice.wav', mimeType: 'audio/wav', data: Buffer.from('audio bytes') },
    ], { model: 'audio-main' })
    expect(result.audio).toHaveLength(1)
    expect(readFileSync(result.audio[0]!.path).toString()).toBe('audio bytes')
    expect(result.text).toEqual([])
  })

  it('does not send an image to a model the provider marks as text-only', async () => {
    configure({ model: 'text-only' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'text-only', architecture: { input_modalities: ['text'] } },
    ] }), { status: 200 })))

    const result = await prepareIncoming([
      { name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') },
    ])

    expect(result.images).toHaveLength(0)
    expect(result.text[0]).toContain('does not accept images')
  })

  it('does not send an image when model vision support is unknown', async () => {
    configure({ model: 'no-metadata' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'no-metadata' }] }), { status: 200 })))

    const result = await prepareIncoming([
      { name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') },
    ])

    expect(result.images).toHaveLength(0)
    expect(result.text[0]).toContain('could not confirm')
  })
})
