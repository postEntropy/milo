import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const oldHome = process.env.MILO_HOME
const oldGroqKey = process.env.GROQ_API_KEY
const home = mkdtempSync(path.join(tmpdir(), 'milo-incoming-'))
process.env.MILO_HOME = home
delete process.env.GROQ_API_KEY
const { prepareIncoming, readIncomingResponse, MAX_INCOMING_BYTES } = await import('../src/core/media.js')
const { ConfigSchema } = await import('../src/core/config/schema.js')
const { saveConfig } = await import('../src/core/config/load.js')

function configure(options: { model: string; vision?: string; document?: string; models?: Record<string, { vision?: boolean }> }): void {
  saveConfig(ConfigSchema.parse({
    provider: 'vision-test',
    model: options.model,
    providers: { 'vision-test': { baseURL: 'http://127.0.0.1:43210/v1', keyless: true } },
    media: { vision: options.vision, document: options.document },
    models: options.models ?? {},
  }))
}

function pdfWithText(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output)
}

afterEach(() => {
  if (oldHome === undefined) delete process.env.MILO_HOME
  else process.env.MILO_HOME = oldHome
  if (oldGroqKey === undefined) delete process.env.GROQ_API_KEY
  else process.env.GROQ_API_KEY = oldGroqKey
})

describe('incoming media', () => {
  it('rejects a batch whose files together exceed the limit', async () => {
    const bytes = new Uint8Array(MAX_INCOMING_BYTES / 2 + 1)
    await expect(prepareIncoming([
      { name: 'a.txt', mimeType: 'text/plain', data: bytes },
      { name: 'b.txt', mimeType: 'text/plain', data: bytes },
    ])).rejects.toThrow('together are larger than 50 MB')
  })

  it('stops preparation when the turn is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(prepareIncoming([{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('hello') }], { signal: controller.signal })).rejects.toThrow()
  })

  it('rejects oversized remote downloads even without a content length', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_INCOMING_BYTES + 1))
        controller.close()
      },
    }))
    await expect(readIncomingResponse(response)).rejects.toThrow('larger than 50 MB')
  })

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

  it('selects the vision model for a mixed turn regardless of attachment order', async () => {
    configure({ model: 'main', vision: 'vision-main', document: 'document-main', models: { 'vision-main': { vision: true } } })
    const image = { name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') }
    const document = { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello') }
    const first = await prepareIncoming([image, document], { model: 'main' })
    const second = await prepareIncoming([document, image], { model: 'main' })
    expect(first.model).toBe('vision-main')
    expect(second.model).toBe('vision-main')
    expect(first.images).toHaveLength(1)
    expect(second.images).toHaveLength(1)
  })

  it('uses a separate vision model as evidence for the answer model', async () => {
    configure({ model: 'main', vision: 'vision-main', models: { 'vision-main': { vision: true } } })
    const analyzeImages = vi.fn(async () => ({ text: 'A blue bicycle.', truncated: false }))
    const result = await prepareIncoming([{ name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') }], {
      model: 'main', question: 'What is pictured?', analyzeImages,
      modelProfile: async (id) => ({ id, vision: id === 'vision-main' }),
    })
    expect(analyzeImages).toHaveBeenCalledWith('vision-main', expect.any(Array), 'What is pictured?')
    expect(result.model).toBeUndefined()
    expect(result.imagesForDisplayOnly).toBe(true)
    expect(result.images[0]?.analysisOnly).toBe(true)
    expect(result.text.join('\n')).toContain('Visual analysis by vision-main:\nA blue bicycle.')
  })

  it('reports a failed vision analysis and does not send the image to the answer model', async () => {
    configure({ model: 'main', vision: 'vision-main', models: { 'vision-main': { vision: true } } })
    const result = await prepareIncoming([{ name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') }], {
      model: 'main', modelProfile: async (id) => ({ id, vision: true }),
      analyzeImages: async () => { throw new Error('unavailable') },
    })
    expect(result.imagesForDisplayOnly).toBe(true)
    expect(result.notices.join('\n')).toContain('unavailable')
  })

  it('classifies generic files by name and reports truncated content', async () => {
    configure({ model: 'main' })
    const result = await prepareIncoming([
      { name: 'notes.json', mimeType: 'application/octet-stream', data: Buffer.from('x'.repeat(100_001)) },
    ], { model: 'main' })
    expect(result.text[0]).toContain('File notes.json:')
    expect(result.notices[0]).toContain('truncated')
    expect(result.notices[0]).toContain('read_attachment')
    expect(readFileSync(`${result.documents[0]!.path}.txt`, 'utf8')).toHaveLength(100_001)
  })

  it.skipIf(!existsSync('/usr/bin/pdftotext') || !existsSync('/usr/bin/pdftoppm'))('sends PDF text and page images to a vision model', async () => {
    configure({ model: 'vision-main', models: { 'vision-main': { vision: true } } })
    const result = await prepareIncoming([
      { name: 'report.pdf', mimeType: 'application/pdf', data: pdfWithText('Annual report') },
    ], { model: 'vision-main' })
    expect(result.text.join('\n')).toContain('[Page 1]')
    expect(result.text.join('\n')).toContain('Annual report')
    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.name).toBe('report.pdf, page 1')
  })

  it.skipIf(!existsSync('/usr/bin/pdftotext') || !existsSync('/usr/bin/pdftoppm'))('does not call a rendered PDF page unreadable just because it has no text', async () => {
    configure({ model: 'vision-main', models: { 'vision-main': { vision: true } } })
    const result = await prepareIncoming([{ name: 'blank.pdf', mimeType: 'application/pdf', data: pdfWithText('') }], { model: 'vision-main' })
    expect(result.images).toHaveLength(1)
    expect(result.notices.join('\n')).not.toContain('cannot be interpreted')
  })

  it.skipIf(!existsSync('/usr/bin/pdftotext'))('keeps the original PDF for a native document model', async () => {
    configure({ model: 'native-main' })
    const data = pdfWithText('Annual report')
    const result = await prepareIncoming([{ name: 'report.pdf', mimeType: 'application/pdf', data }], {
      model: 'native-main',
      modelProfile: async (id) => ({ id, vision: true, document: true }),
      supportsNativePdf: async () => true,
    })
    expect(result.images).toHaveLength(0)
    expect(result.documents[0]).toMatchObject({ name: 'report.pdf', nativeEligible: true })
    expect(readFileSync(result.documents[0]!.path)).toEqual(data)
    expect(result.notices.join('\n')).not.toContain('visual content')
  })

  it.skipIf(!existsSync('/usr/bin/pdftoppm') || !existsSync('/usr/bin/tesseract'))('extracts visible text from an image when the model cannot see', async () => {
    configure({ model: 'ocr-only', models: { 'ocr-only': { vision: false } } })
    const source = path.join(home, 'ocr-test.pdf')
    const target = path.join(home, 'ocr-test')
    writeFileSync(source, pdfWithText('Annual report'))
    execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '200', '-singlefile', '-png', source, target])
    const result = await prepareIncoming([
      { name: 'report.png', mimeType: 'image/png', data: readFileSync(`${target}.png`) },
    ], { model: 'ocr-only' })
    expect(result.images).toHaveLength(1)
    expect(result.imagesForDisplayOnly).toBe(true)
    expect(result.text.join('\n')).toContain('Annual report')
    expect(result.notices.join('\n')).toContain('OCR only reads text')
  })

  it.skipIf(!existsSync('/usr/bin/zip') || !existsSync('/usr/bin/unzip'))('preserves sparse columns and inline text in spreadsheets', async () => {
    configure({ model: 'main' })
    const dir = mkdtempSync(path.join(home, 'sheet-'))
    mkdirSync(path.join(dir, 'xl/worksheets'), { recursive: true })
    writeFileSync(path.join(dir, 'xl/worksheets/sheet1.xml'), '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>First</t></is></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>')
    const archive = path.join(dir, 'sheet.xlsx')
    execFileSync('zip', ['-q', archive, 'xl/worksheets/sheet1.xml'], { cwd: dir })
    const result = await prepareIncoming([{ name: 'sheet.xlsx', mimeType: 'application/octet-stream', data: readFileSync(archive) }], { model: 'main' })
    expect(result.text.join('\n')).toContain('[Sheet 1]\nFirst\t\t42')
    expect(result.notices.join('\n')).toContain('only extracted text')
  })

  it('uses the active session profile for vision decisions', async () => {
    configure({ model: 'main' })
    const result = await prepareIncoming([{ name: 'photo.png', mimeType: 'image/png', data: Buffer.from('picture') }], {
      model: 'main',
      modelProfile: async (id) => ({ id, vision: true }),
    })
    expect(result.images).toHaveLength(1)
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

    expect(result.images).toHaveLength(1)
    expect(result.imagesForDisplayOnly).toBe(true)
    expect(result.text[0]).toContain('does not accept images')
  })

  it('does not send an image when model vision support is unknown', async () => {
    configure({ model: 'no-metadata' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'no-metadata' }] }), { status: 200 })))

    const result = await prepareIncoming([
      { name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') },
    ])

    expect(result.images).toHaveLength(1)
    expect(result.imagesForDisplayOnly).toBe(true)
    expect(result.text[0]).toContain('could not confirm')
  })

  it('keeps the picture when the model profile already records that it reads them', async () => {
    // The fact was learned on an earlier run and sits in models.json; a catalog
    // that cannot be reached must not turn it back into "unknown".
    writeFileSync(path.join(home, 'models.json'), JSON.stringify({
      'cached-vision': { profile: { id: 'cached-vision', vision: true }, at: Date.now() },
    }))
    configure({ model: 'cached-vision' })
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await prepareIncoming([
      { name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') },
    ])

    expect(result.images).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('takes the vision fact written for the model in the config', async () => {
    configure({ model: 'override-vision', models: { 'override-vision': { vision: true } } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))

    const result = await prepareIncoming([
      { name: 'photo.png', mimeType: 'image/png', data: Buffer.from('image bytes') },
    ])

    expect(result.images).toHaveLength(1)
  })

  it('says a picture it could not convert was not sent, rather than dropping it in silence', async () => {
    configure({ model: 'heic-model', models: { 'heic-model': { vision: true } } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))

    const result = await prepareIncoming([
      { name: 'photo.heic', mimeType: 'image/heic', data: Buffer.from('not a picture') },
    ])

    expect(result.images).toHaveLength(0)
    expect(result.text[0]).toContain('could not be converted')
    expect(result.text[0]).toContain('png or a jpeg')
  })
})
