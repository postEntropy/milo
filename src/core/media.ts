import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MILO_HOME } from './config/paths.js'
import { ensurePrivateDir, PRIVATE_FILE_MODE } from '../util/fs.js'
import { loadConfig, readAuth, readConfig } from './config/load.js'
import { saveIncomingImage } from './images.js'
import type { AudioPart, ImagePart } from './providers/types.js'
import { lookupAudioSupport, lookupVisionSupport } from './providers/vision.js'

const execFile = promisify(execFileCallback)
const MEDIA_DIR = path.join(MILO_HOME, 'incoming')

export interface IncomingFile {
  name: string
  mimeType: string
  data: Uint8Array
}

export interface PreparedMedia {
  images: ImagePart[]
  audio: AudioPart[]
  text: string[]
  model?: string
}

export interface PrepareIncomingOptions {
  /** The session's active model; it may differ from the saved default. */
  model?: string
}

/** Persist and lightly decode incoming media without putting file bytes in sessions. */
export async function prepareIncoming(files: IncomingFile[], options: PrepareIncomingOptions = {}): Promise<PreparedMedia> {
  ensurePrivateDir(MEDIA_DIR)
  const prepared: PreparedMedia = { images: [], audio: [], text: [] }
  const loaded = loadConfig()
  const config = loaded?.config ?? readConfig()
  for (const file of files) {
    const safeName = path.basename(file.name).replace(/[\r\n]/g, '_') || 'attachment'
    const ext = path.extname(safeName).slice(0, 12)
    const stored = path.join(MEDIA_DIR, `${randomUUID()}${ext}`)
    await writeFile(stored, file.data, { mode: PRIVATE_FILE_MODE })
    if (file.mimeType.startsWith('image/')) {
      const visionModel = config?.media?.vision ?? options.model ?? config?.model
      const visionSupport = loaded && visionModel
        ? await lookupVisionSupport(loaded.provider, visionModel)
        : undefined
      const explicitlySelected = Boolean(config?.media?.vision)
      if (visionSupport === false || (visionSupport === undefined && !explicitlySelected)) {
        const reason = visionSupport === false
          ? `The selected model "${visionModel ?? 'unknown'}" does not accept images.`
          : `Milo could not confirm that the selected model "${visionModel ?? 'unknown'}" accepts images.`
        prepared.text.push(`${safeName} was attached but not sent: ${reason} Set a vision model in Settings to analyze images.`)
        await unlink(stored).catch(() => undefined)
        continue
      }
      if (config?.media?.vision) prepared.model = config.media.vision
      if (file.mimeType === 'image/png' || file.mimeType === 'image/jpeg') {
        prepared.images.push(await saveIncomingImage({ mimeType: file.mimeType, data: file.data, name: safeName }))
      } else {
        const converted = path.join(MEDIA_DIR, `${randomUUID()}.jpg`)
        await execFile('ffmpeg', ['-v', 'error', '-i', stored, '-frames:v', '1', converted], { timeout: 10_000, maxBuffer: 1_000_000 })
        prepared.images.push(await saveIncomingImage({ mimeType: 'image/jpeg', data: await readFile(converted), name: safeName }))
        await unlink(converted).catch(() => undefined)
      }
      await unlink(stored).catch(() => undefined)
      continue
    }
    if (file.mimeType.startsWith('text/') || /json|xml|javascript|x-yaml/.test(file.mimeType)) {
      prepared.model = config?.media?.document
      prepared.text.push(`File ${safeName}:\n${Buffer.from(file.data).toString('utf8').slice(0, 100_000)}`)
      await unlink(stored).catch(() => undefined)
      continue
    }
    if (file.mimeType === 'application/pdf') {
      prepared.model = config?.media?.document
      try {
        const { stdout } = await execFile('pdftotext', [stored, '-'], { timeout: 12_000, maxBuffer: 2_000_000 })
        if (stdout.trim()) prepared.text.push(`PDF ${safeName}:\n${stdout.slice(0, 100_000)}`)
        else prepared.text.push(`PDF ${safeName} was attached, but contains no extractable text.`)
      } catch {
        prepared.text.push(`PDF ${safeName} was attached, but its text could not be extracted.`)
      }
      await unlink(stored).catch(() => undefined)
      continue
    }
    if (file.mimeType.includes('wordprocessingml.document') || ['.docx', '.xlsx', '.pptx'].includes(ext.toLowerCase())) {
      prepared.model = config?.media?.document
      try {
        const text = await extractOfficeText(stored, ext.toLowerCase())
        prepared.text.push(text ? `Document ${safeName}:\n${text.slice(0, 100_000)}` : `Document ${safeName} contains no extractable text.`)
      } catch {
        prepared.text.push(`Document ${safeName} was attached, but its text could not be extracted.`)
      }
      await unlink(stored).catch(() => undefined)
      continue
    }
    if (file.mimeType.startsWith('audio/')) {
      const audioSupport = loaded && options.model && loaded.provider.wire !== 'anthropic'
        ? await lookupAudioSupport(loaded.provider, options.model)
        : undefined
      if (audioSupport === true) {
        const mimeType = file.mimeType === 'audio/mpeg' || file.mimeType === 'audio/wav' || file.mimeType === 'audio/x-wav'
          ? file.mimeType
          : 'audio/mpeg'
        const audioPath = mimeType === file.mimeType ? stored : path.join(MEDIA_DIR, `${randomUUID()}.mp3`)
        try {
          if (audioPath !== stored) {
            await execFile('ffmpeg', ['-v', 'error', '-i', stored, '-vn', '-codec:a', 'libmp3lame', audioPath], { timeout: 15_000, maxBuffer: 1_000_000 })
            await unlink(stored).catch(() => undefined)
          }
          prepared.audio.push({ type: 'audio', mimeType, path: audioPath, name: safeName })
          continue
        } catch {
          if (audioPath !== stored) await unlink(audioPath).catch(() => undefined)
        }
      }
      prepared.text.push(await transcribeWithGroq(file, safeName))
      await unlink(stored).catch(() => undefined)
      continue
    }
    prepared.text.push(`File ${safeName} (${file.mimeType}) was attached. Milo cannot extract its contents yet.`)
    prepared.model = config?.media?.document
    await unlink(stored).catch(() => undefined)
  }
  return prepared
}

async function extractOfficeText(file: string, extension: string): Promise<string> {
  const { stdout: listing } = await execFile('unzip', ['-Z1', file], { timeout: 12_000, maxBuffer: 1_000_000 })
  const names = listing.split('\n').filter(Boolean)
  if (extension === '.docx') {
    const { stdout } = await execFile('unzip', ['-p', file, 'word/document.xml'], { timeout: 12_000, maxBuffer: 2_000_000 })
    return xmlText(stdout)
  }
  if (extension === '.pptx') {
    const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).slice(0, 100)
    const contents = await Promise.all(slides.map(async (name) => {
      const { stdout } = await execFile('unzip', ['-p', file, name], { timeout: 12_000, maxBuffer: 1_000_000 })
      return xmlText(stdout)
    }))
    return contents.filter(Boolean).join('\n')
  }
  const stringsPath = names.includes('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : ''
  const stringsXml = stringsPath ? (await execFile('unzip', ['-p', file, stringsPath], { timeout: 12_000, maxBuffer: 2_000_000 })).stdout : ''
  const shared = [...stringsXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1] ?? ''))
  const sheets = names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).slice(0, 100)
  const rows: string[] = []
  for (const sheet of sheets) {
    const { stdout } = await execFile('unzip', ['-p', file, sheet], { timeout: 12_000, maxBuffer: 2_000_000 })
    for (const row of stdout.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...(row[1] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell[2] ?? '')?.[1] ?? ''
        const index = /\bt="s"/.test(cell[1] ?? '') ? Number(raw) : -1
        return index >= 0 ? shared[index] ?? '' : xmlText(raw)
      })
      rows.push(cells.join('\t'))
    }
  }
  return rows.join('\n')
}

function xmlText(xml: string): string {
  return xml.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<\/w:p>|<\/a:p>|<\/row>/g, '\n')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim()
}

async function transcribeWithGroq(file: IncomingFile, name: string): Promise<string> {
  const key = process.env.GROQ_API_KEY?.trim() || readAuth().providers.groq
  if (!key) return `Audio ${name} was attached. Set GROQ_API_KEY to enable Whisper transcription.`
  const form = new FormData()
  form.set('file', new Blob([file.data], { type: file.mimeType }), name)
  form.set('model', readConfig()?.media?.audio ?? 'whisper-large-v3-turbo')
  try {
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form,
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) throw new Error(`Groq returned ${response.status}`)
    const result = await response.json() as { text?: string }
    return `Audio transcript (${name}):\n${result.text?.trim() || '[No speech recognized]'}`
  } catch (error) {
    return `Audio ${name} was attached, but transcription failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
