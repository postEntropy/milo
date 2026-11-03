import { readFileSync, statSync } from 'node:fs'
import type { Message, Provider } from './types.js'
import type { ModelProfile } from './profile.js'

/** Leave room for the rest of an inline request, including base64 overhead. */
export const MAX_INLINE_PDF_BYTES = 10 * 1024 * 1024

/** PDF support is opt-in per route; known model families refine the profile when enabled. */
export function canSendNativePdf(provider: Provider, model: string, profile: ModelProfile | undefined): boolean {
  if (!provider.nativePdf || profile?.document === false) return false
  if (profile?.document === true) return true
  if (profile?.vision !== true) return false
  return provider.nativePdf === 'openai'
    ? /^gpt-(?:4o|4\.1|5|6)(?:[-.]|$)/i.test(model)
    : /^claude-(?:3|4|5|(?:opus|sonnet|haiku)-(?:4|5))(?:[-.]|$)/i.test(model)
}

/** Prefer recent PDFs when the request cannot hold every document in its history. */
export function inlinePdfs(messages: Message[], enabled: boolean): Map<string, string> {
  const files = new Map<string, string>()
  if (!enabled) return files
  let remaining = MAX_INLINE_PDF_BYTES
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    for (const part of message.content) {
      if (part.type !== 'document' || part.mimeType !== 'application/pdf' || part.nativeEligible === false || files.has(part.path)) continue
      try {
        const size = statSync(part.path).size
        if (size > remaining) continue
        const bytes = readFileSync(part.path)
        if (bytes.length > remaining) continue
        files.set(part.path, bytes.toString('base64'))
        remaining -= bytes.length
      } catch {
        // The caller adds a text marker so a missing file is never silently lost.
      }
    }
  }
  return files
}
