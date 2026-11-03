import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MILO_HOME } from './config/paths.js'
import { ensurePrivateDir, PRIVATE_FILE_MODE, writePrivateFile } from '../util/fs.js'
import { loadConfig, readAuth, readConfig } from './config/load.js'
import { saveIncomingImage } from './images.js'
import type { AudioPart, DocumentPart, ImagePart } from './providers/types.js'
import { lookupModelProfile, type ModelProfile } from './providers/profile.js'
import { listModels } from './providers/models.js'
import { MAX_INLINE_PDF_BYTES } from './providers/native-pdf.js'

const execFile = promisify(execFileCallback)
const MEDIA_DIR = path.join(MILO_HOME, 'incoming')
export const MAX_INCOMING_BYTES = 50 * 1024 * 1024
export const MAX_INCOMING_TOTAL_BYTES = 50 * 1024 * 1024

/** Read a remote attachment without buffering more than an upload can hold. */
export async function readIncomingResponse(response: Response): Promise<Uint8Array> {
  const tooLarge = (): Error => new Error('That file is larger than 50 MB.')
  const length = Number(response.headers.get('content-length'))
  if (length > MAX_INCOMING_BYTES) {
    await response.body?.cancel()
    throw tooLarge()
  }
  if (!response.body) throw new Error('The attachment has no body.')
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_INCOMING_BYTES) {
        await reader.cancel()
        throw tooLarge()
      }
      chunks.push(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (!total) throw new Error('The selected file is empty.')
  return Buffer.concat(chunks, total)
}

export interface IncomingFile {
  name: string
  mimeType: string
  data: Uint8Array
}

export interface PreparedMedia {
  images: ImagePart[]
  audio: AudioPart[]
  documents: DocumentPart[]
  /** Images were analyzed by a separate model and must not be resent to the answer model. */
  imagesForDisplayOnly: boolean
  text: string[]
  model?: string
  /** Problems and incomplete extractions the surface must show directly. */
  notices: string[]
}

export interface PrepareIncomingOptions {
  /** The session's active model; it may differ from the saved default. */
  model?: string
  modelProfile?: (model: string) => Promise<ModelProfile | undefined>
  supportsNativePdf?: (model: string) => Promise<boolean>
  analyzeImages?: (model: string, images: ImagePart[], question: string) => Promise<{ text: string; truncated: boolean }>
  question?: string
  signal?: AbortSignal
}

/** Persist and lightly decode incoming media without putting file bytes in sessions. */
export async function prepareIncoming(files: IncomingFile[], options: PrepareIncomingOptions = {}): Promise<PreparedMedia> {
  if (files.reduce((total, file) => total + file.data.byteLength, 0) > MAX_INCOMING_TOTAL_BYTES) throw new Error('Attachments together are larger than 50 MB.')
  for (const file of files) {
    if (file.data.byteLength === 0) throw new Error(`The selected file ${file.name} is empty.`)
    if (file.data.byteLength > MAX_INCOMING_BYTES) throw new Error(`${file.name} is larger than 50 MB.`)
  }
  ensurePrivateDir(MEDIA_DIR)
  const prepared: PreparedMedia = { images: [], audio: [], documents: [], imagesForDisplayOnly: false, text: [], notices: [] }
  const notice = (message: string): void => { prepared.notices.push(message); prepared.text.push(message) }
  const addText = async (label: string, text: string, document?: DocumentPart): Promise<void> => {
    const limit = 100_000
    if (document) await writePrivateFile(`${document.path}.txt`, text)
    prepared.text.push(`${label}:\n${text.slice(0, limit)}`)
    if (text.length > limit) {
      const continuation = document ? ` Use read_attachment with id ${path.basename(document.path).slice(0, 12)} to read the rest.` : ''
      notice(`${label} was truncated to ${limit.toLocaleString('en-US')} characters; the rest was not sent.${continuation}`)
    }
  }
  const loaded = loadConfig()
  const config = loaded?.config ?? readConfig()
  const profileOf = (model: string | undefined) =>
    model && options.modelProfile
      ? options.modelProfile(model)
      : loaded && model
      ? lookupModelProfile(model, {
          override: config?.models?.[model],
          fetchProvider: () =>
            listModels({
              baseURL: loaded.provider.baseURL,
              apiKey: loaded.provider.apiKey,
              wire: loaded.provider.wire,
              headers: loaded.provider.headers,
              signal: AbortSignal.timeout(4_000),
            }),
        })
      : undefined
  // The selected model is a property of the whole turn, never of the last file.
  const hasImages = files.some((file) => incomingMime(file).startsWith('image/'))
  const hasDocuments = files.some((file) => !incomingMime(file).startsWith('image/') && !incomingMime(file).startsWith('audio/'))
  const visionModel = config?.media?.vision ?? (!hasImages && hasDocuments ? config?.media?.document : undefined) ?? options.model ?? config?.model
  let visionSupport: boolean | undefined
  let visionChecked = false
  const canSee = async (): Promise<boolean> => {
    if (!visionChecked) {
      visionSupport = (await profileOf(visionModel))?.vision
      visionChecked = true
    }
    return visionSupport === true || (visionSupport === undefined && Boolean(config?.media?.vision))
  }
  const answerModel = (hasDocuments ? config?.media?.document : undefined) ?? options.model ?? config?.model
  const useAuxiliary = Boolean(config?.media?.vision && visionModel !== answerModel && options.analyzeImages)
  const nativeModel = useAuxiliary ? answerModel : hasImages ? visionModel : answerModel
  const nativeAllowed = Boolean(nativeModel && await options.supportsNativePdf?.(nativeModel))
  const nativeFiles = new Set<IncomingFile>()
  let nativeBudget = MAX_INLINE_PDF_BYTES
  if (nativeAllowed) {
    for (const file of [...files].reverse()) {
      if (incomingMime(file) !== 'application/pdf' || file.data.byteLength > nativeBudget) continue
      nativeFiles.add(file)
      nativeBudget -= file.data.byteLength
    }
  }
  for (const file of files) {
    options.signal?.throwIfAborted()
    const mimeType = incomingMime(file)
    const safeName = path.basename(file.name).replace(/[\r\n]/g, '_') || 'attachment'
    const ext = path.extname(safeName).slice(0, 12)
    const stored = path.join(MEDIA_DIR, `${randomUUID()}${ext}`)
    let keepStored = false
    try {
      await writeFile(stored, file.data, { mode: PRIVATE_FILE_MODE })
      if (mimeType.startsWith('image/')) {
        // Whether a model reads a picture is a fact about the model, and the profile
        // is where that fact lives — the person's own word, then the provider's
        // catalog, then the public one, cached between runs. Asking the catalog a
        // second way here is how the answer on disk and the answer in this check
        // drift apart, and it once meant refusing a picture for a model Milo had
        // already recorded as reading them.
        if (!(await canSee())) {
          let picture: ImagePart | undefined
          if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
            picture = await saveIncomingImage({ mimeType, data: file.data, name: safeName })
            picture.analysisOnly = true
            prepared.images.push(picture)
            prepared.imagesForDisplayOnly = true
          }
          const reason = visionSupport === false
            ? `The selected model "${visionModel ?? 'unknown'}" does not accept images.`
            : `Milo could not confirm that the selected model "${visionModel ?? 'unknown'}" accepts images.`
          const extracted = await ocrImage(stored, options.signal)
          if (extracted) {
            if (picture) await writePrivateFile(`${picture.path}.txt`, extracted)
            await addText(`OCR text from image ${safeName}`, extracted)
            notice(`${safeName} was read with OCR because ${reason} OCR only reads text, not visual content.`)
          } else {
            notice(`${safeName} was attached but not sent: ${reason} OCR could not extract text. Set a vision model in Settings to analyze images.`)
          }
          await unlink(stored).catch(() => undefined)
          continue
        }
        if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
          prepared.images.push(await saveIncomingImage({ mimeType, data: file.data, name: safeName }))
        } else {
          const converted = path.join(MEDIA_DIR, `${randomUUID()}.jpg`)
          try {
            await execFile('ffmpeg', ['-v', 'error', '-i', stored, '-frames:v', '1', converted], { timeout: 10_000, maxBuffer: 1_000_000, signal: options.signal })
            prepared.images.push(await saveIncomingImage({ mimeType: 'image/jpeg', data: await readFile(converted), name: safeName }))
          } catch {
            options.signal?.throwIfAborted()
            // A format this machine's ffmpeg cannot open — a heic from a phone, as a
            // rule. Said plainly, because a turn that loses the picture in silence
            // reads as a model that looked and saw nothing.
            notice(`${safeName} was attached, but it could not be converted to a picture. Send it as a png or a jpeg.`)
          } finally {
            await unlink(converted).catch(() => undefined)
          }
        }
        await unlink(stored).catch(() => undefined)
        continue
      }
      if (!mimeType.startsWith('audio/')) prepared.documents.push(await saveIncomingDocument(file, safeName, mimeType))
      if (mimeType.startsWith('text/') || /json|xml|javascript|x-yaml/.test(mimeType)) {
        await addText(`File ${safeName}`, Buffer.from(file.data).toString('utf8'), prepared.documents.at(-1))
        await unlink(stored).catch(() => undefined)
        continue
      }
      if (mimeType === 'application/pdf') {
        try {
          const { stdout } = await execFile('pdftotext', [stored, '-'], { timeout: 12_000, maxBuffer: 20_000_000, signal: options.signal })
          const pages = stdout.split('\f')
          if (pages.at(-1) === '') pages.pop()
          const missing = pages.flatMap((page, index) => page.trim() ? [] : [index + 1])
          const native = nativeFiles.has(file) && pages.length <= 100
          const document = prepared.documents.at(-1)
          if (document) document.nativeEligible = file.data.byteLength <= MAX_INLINE_PDF_BYTES && pages.length <= 100
          const ocr = native ? new Map<number, string>() : await ocrPdfPages(stored, missing, options.signal)
          const visualPages = new Set<number>()
          const canRender = !native && pages.length > 0 && await canSee()
          if (canRender) {
            const rendered = await renderPdfPages(stored, safeName, Math.min(pages.length, 5), options.signal)
            prepared.images.push(...rendered)
            for (const image of rendered) {
              const page = Number(/, page (\d+)$/.exec(image.name)?.[1])
              if (page) visualPages.add(page)
            }
            if (rendered.length < pages.length) notice(`PDF ${safeName}: ${rendered.length} of ${pages.length} pages were sent as images; visual content on other pages was not sent.`)
          } else if (pages.length && !native) {
            notice(`PDF ${safeName}: only extracted text was sent; images, charts and layout may be missing.`)
          }
          const text = pages.map((page, index) => {
            const extracted = page.trim() || ocr.get(index + 1)
            return extracted ? `[Page ${index + 1}${page.trim() ? '' : ', OCR'}]\n${extracted}` : ''
          }).filter(Boolean).join('\n\n')
          if (text) await addText(`PDF ${safeName}`, text, document)
          const unread = missing.filter((page) => !ocr.has(page) && !visualPages.has(page))
          if (unread.length && !native) notice(`PDF ${safeName}: pages ${unread.join(', ')} contain no extractable text; images and blank pages cannot be interpreted from text alone.`)
          if (!pages.length && !native) notice(`PDF ${safeName} was attached, but contains no extractable text.`)
          if (ocr.size) notice(`PDF ${safeName}: ${ocr.size} page(s) were read with OCR using the installed default language; visual content may be missing.`)
        } catch {
          options.signal?.throwIfAborted()
          notice(`PDF ${safeName} was attached, but its text could not be extracted locally.`)
        }
        await unlink(stored).catch(() => undefined)
        continue
      }
      if (mimeType.includes('wordprocessingml.document') || ['.docx', '.xlsx', '.pptx'].includes(ext.toLowerCase())) {
        try {
          const extracted = await extractOfficeText(stored, ext.toLowerCase(), options.signal)
          if (extracted.text) await addText(`Document ${safeName}`, extracted.text, prepared.documents.at(-1))
          else notice(`Document ${safeName} contains no extractable text.`)
          notice(`Document ${safeName}: only extracted text was sent; images and layout may be missing.`)
          if (extracted.truncated) notice(`Document ${safeName}: only the first 100 slides or sheets were read.`)
        } catch {
          options.signal?.throwIfAborted()
          notice(`Document ${safeName} was attached, but its text could not be extracted.`)
        }
        await unlink(stored).catch(() => undefined)
        continue
      }
      if (mimeType.startsWith('audio/')) {
        const audioSupport =
          loaded && loaded.provider.wire !== 'anthropic'
            ? (await profileOf(useAuxiliary ? answerModel : hasImages ? visionModel : answerModel))?.audio
            : undefined
        if (audioSupport === true) {
          const audioMime = mimeType === 'audio/mpeg' || mimeType === 'audio/wav' || mimeType === 'audio/x-wav'
            ? mimeType
            : 'audio/mpeg'
          const audioPath = audioMime === mimeType ? stored : path.join(MEDIA_DIR, `${randomUUID()}.mp3`)
          try {
            if (audioPath !== stored) {
              await execFile('ffmpeg', ['-v', 'error', '-i', stored, '-vn', '-codec:a', 'libmp3lame', audioPath], { timeout: 15_000, maxBuffer: 1_000_000, signal: options.signal })
              await unlink(stored).catch(() => undefined)
            }
            prepared.audio.push({ type: 'audio', mimeType: audioMime, path: audioPath, name: safeName })
            keepStored = audioPath === stored
            continue
          } catch {
            options.signal?.throwIfAborted()
            if (audioPath !== stored) await unlink(audioPath).catch(() => undefined)
          }
        }
        prepared.text.push(await transcribeWithGroq(file, safeName, options.signal))
        await unlink(stored).catch(() => undefined)
        continue
      }
      notice(`File ${safeName} (${mimeType}) was attached. Milo cannot extract its contents yet.`)
      await unlink(stored).catch(() => undefined)
    } finally {
      if (!keepStored) await unlink(stored).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  if (useAuxiliary && visionModel && prepared.images.length && !prepared.imagesForDisplayOnly && options.analyzeImages) {
    prepared.imagesForDisplayOnly = true
    for (const image of prepared.images) image.analysisOnly = true
    try {
      const description = await options.analyzeImages(visionModel, prepared.images, options.question ?? '')
      prepared.text.push(`Visual analysis by ${visionModel}:\n${description.text}${description.truncated ? '\n[Visual analysis was truncated.]' : ''}`)
      notice(`Images were analyzed by ${visionModel}; the answer model receives that description.${description.truncated ? ' The analysis was truncated.' : ''}`)
    } catch (error) {
      options.signal?.throwIfAborted()
      notice(`The vision model could not analyze the images: ${error instanceof Error ? error.message : String(error)}`)
      for (const picture of prepared.images) {
        const extracted = await ocrImage(picture.path, options.signal)
        if (extracted) {
          if (!picture.derivedFromDocument) await writePrivateFile(`${picture.path}.txt`, extracted)
          await addText(`OCR text from image ${picture.name}`, extracted)
        }
      }
    }
  }
  const selectedModel = prepared.imagesForDisplayOnly || (useAuxiliary && prepared.images.length) ? answerModel : prepared.images.length ? visionModel : hasDocuments ? config?.media?.document : undefined
  if (selectedModel && selectedModel !== options.model) prepared.model = selectedModel
  return prepared
}

/** Store one copy of each document; sessions and their forks may refer to it. */
async function saveIncomingDocument(file: IncomingFile, name: string, mimeType: string): Promise<DocumentPart> {
  const dir = path.join(MILO_HOME, 'documents')
  ensurePrivateDir(dir)
  const target = path.join(dir, createHash('sha256').update(`${mimeType}\0${path.extname(name).toLowerCase()}\0`).update(file.data).digest('hex'))
  try {
    await utimes(target, new Date(), new Date())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const temp = path.join(dir, `${randomUUID()}.tmp`)
    try {
      await writeFile(temp, file.data, { mode: PRIVATE_FILE_MODE })
      await rename(temp, target)
    } finally {
      await unlink(temp).catch(() => undefined)
    }
  }
  return { type: 'document', mimeType, path: target, name }
}

/** OCR is a text fallback, not a description of the picture. */
async function ocrImage(file: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFile('tesseract', [file, 'stdout'], { timeout: 20_000, maxBuffer: 2_000_000, signal })
    return stdout.trim()
  } catch {
    signal?.throwIfAborted()
    return ''
  }
}

/** Try a bounded number of pages; absence of the tools or failed OCR is reported by the caller. */
async function ocrPdfPages(file: string, pages: number[], signal?: AbortSignal): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  if (!pages.length) return result
  const dir = await mkdtemp(path.join(MEDIA_DIR, 'ocr-'))
  try {
    for (const page of pages.slice(0, 10)) {
      signal?.throwIfAborted()
      const target = path.join(dir, `page-${page}`)
      try {
        await execFile('pdftoppm', ['-f', String(page), '-l', String(page), '-scale-to', '2400', '-singlefile', '-png', file, target], { timeout: 15_000, maxBuffer: 1_000_000, signal })
        const text = await ocrImage(`${target}.png`, signal)
        if (text) result.set(page, text)
      } catch {
        signal?.throwIfAborted()
        // The caller lists every page for which no text was recovered.
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  return result
}

/** Render pages for vision so charts, layout and scans do not disappear in text extraction. */
async function renderPdfPages(file: string, name: string, count: number, signal?: AbortSignal): Promise<ImagePart[]> {
  const pages: ImagePart[] = []
  const dir = await mkdtemp(path.join(MEDIA_DIR, 'pages-'))
  try {
    for (let page = 1; page <= count; page++) {
      signal?.throwIfAborted()
      const target = path.join(dir, `page-${page}`)
      try {
        await execFile('pdftoppm', ['-f', String(page), '-l', String(page), '-scale-to', '1600', '-singlefile', '-jpeg', file, target], { timeout: 15_000, maxBuffer: 1_000_000, signal })
        pages.push({ ...await saveIncomingImage({ mimeType: 'image/jpeg', data: await readFile(`${target}.jpg`), name: `${name}, page ${page}` }), derivedFromDocument: true })
      } catch {
        signal?.throwIfAborted()
        // The caller reports the missing visual pages.
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  return pages
}

/** Resolve missing or generic MIME types consistently on every surface. */
function incomingMime(file: IncomingFile): string {
  const bytes = Buffer.from(file.data.buffer, file.data.byteOffset, Math.min(file.data.byteLength, 16))
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  const declared = file.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (declared && declared !== 'application/octet-stream') return declared
  const extension = path.extname(file.name).toLowerCase()
  const types: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.heic': 'image/heic', '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    '.xml': 'application/xml', '.yaml': 'application/x-yaml', '.yml': 'application/x-yaml',
    '.js': 'text/javascript', '.ts': 'text/plain', '.log': 'text/plain',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  }
  return types[extension] ?? 'application/octet-stream'
}

async function extractOfficeText(file: string, extension: string, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const { stdout: listing } = await execFile('unzip', ['-Z1', file], { timeout: 12_000, maxBuffer: 1_000_000, signal })
  const names = listing.split('\n').filter(Boolean)
  if (extension === '.docx') {
    const { stdout } = await execFile('unzip', ['-p', file, 'word/document.xml'], { timeout: 12_000, maxBuffer: 2_000_000, signal })
    return { text: xmlText(stdout), truncated: false }
  }
  if (extension === '.pptx') {
    const allSlides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    const slides = allSlides.slice(0, 100)
    const contents: string[] = []
    for (const name of slides) {
      signal?.throwIfAborted()
      const { stdout } = await execFile('unzip', ['-p', file, name], { timeout: 12_000, maxBuffer: 1_000_000, signal })
      contents.push(`[Slide ${Number(/slide(\d+)\.xml$/.exec(name)?.[1])}]\n${xmlText(stdout)}`)
    }
    return { text: contents.join('\n\n'), truncated: allSlides.length > slides.length }
  }
  const stringsPath = names.includes('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : ''
  const stringsXml = stringsPath ? (await execFile('unzip', ['-p', file, stringsPath], { timeout: 12_000, maxBuffer: 2_000_000, signal })).stdout : ''
  const shared = [...stringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1] ?? ''))
  const allSheets = names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const sheets = allSheets.slice(0, 100)
  const rows: string[] = []
  for (const sheet of sheets) {
    signal?.throwIfAborted()
    rows.push(`[Sheet ${Number(/sheet(\d+)\.xml$/.exec(sheet)?.[1])}]`)
    const { stdout } = await execFile('unzip', ['-p', file, sheet], { timeout: 12_000, maxBuffer: 2_000_000, signal })
    for (const row of stdout.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attributes = cell[1] ?? ''
        const content = cell[2] ?? ''
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(content)?.[1] ?? (/\bt="inlineStr"/.test(attributes) ? xmlText(content) : '')
        const sharedIndex = /\bt="s"/.test(attributes) ? Number(raw) : -1
        const reference = /\br="([A-Z]+)\d+"/.exec(attributes)?.[1]
        const column = reference ? [...reference].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1 : cells.length
        // Excel's last column is XFD; bound sparse rows before allocating.
        if (column < 0 || column >= 16_384) continue
        while (cells.length < column) cells.push('')
        cells[column] = sharedIndex >= 0 ? shared[sharedIndex] ?? '' : xmlText(raw)
      }
      rows.push(cells.join('\t'))
    }
  }
  return { text: rows.join('\n'), truncated: allSheets.length > sheets.length }
}

function xmlText(xml: string): string {
  return xml.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<\/w:p>|<\/a:p>|<\/row>/g, '\n')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, code: string) => {
      const value = code[0]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10)
      return value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '\ufffd'
    }).trim()
}

async function transcribeWithGroq(file: IncomingFile, name: string, signal?: AbortSignal): Promise<string> {
  const key = process.env.GROQ_API_KEY?.trim() || readAuth().providers.groq
  if (!key) return `Audio ${name} was attached. Set GROQ_API_KEY to enable Whisper transcription.`
  const form = new FormData()
  form.set('file', new Blob([file.data], { type: file.mimeType }), name)
  form.set('model', readConfig()?.media?.audio ?? 'whisper-large-v3-turbo')
  try {
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    })
    if (!response.ok) throw new Error(`Groq returned ${response.status}`)
    const result = await response.json() as { text?: string }
    return `Audio transcript (${name}):\n${result.text?.trim() || '[No speech recognized]'}`
  } catch (error) {
    signal?.throwIfAborted()
    return `Audio ${name} was attached, but transcription failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
