import path from 'node:path'
import { prepareIncoming, type IncomingFile, type PreparedMedia } from '../core/media.js'
import type { Session } from '../core/session.js'

/** The same preparation and model choice for every surface that sends a turn. */
export async function prepareTurnMedia(session: Session, text: string, files: IncomingFile[], signal?: AbortSignal): Promise<PreparedMedia & { prompt: string; displayText: string }> {
  const prepared = await prepareIncoming(files, {
    model: session.model,
    modelProfile: (model) => session.modelProfile(model),
    supportsNativePdf: (model) => session.supportsNativePdf(model),
    question: text,
    signal,
    analyzeImages: (model, images, question) => session.analyzeImages(model, images, question, signal),
  })
  const names = files.map((file) => `Attached ${path.basename(file.name).replace(/[\r\n]/g, '_') || 'attachment'}`).join('\n')
  return { ...prepared, displayText: text || (prepared.documents.length || prepared.images.some((image) => !image.derivedFromDocument) ? '' : names), prompt: [text, names, ...prepared.text].filter(Boolean).join('\n\n') || 'Please inspect the attached media.' }
}
