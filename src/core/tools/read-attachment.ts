import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'

const schema = z.object({
  id: z.string().optional().describe("Attachment ID from the list. Omit to list this session's attachments."),
  question: z.string().optional().describe('What to inspect in an image.'),
  offset: z.number().int().nonnegative().optional().describe('Zero-based character offset to start reading.'),
})

/** An attachment is reachable only through the session that received it. */
export const readAttachmentTool: Tool<z.infer<typeof schema>> = {
  name: 'read_attachment',
  description: "List this session's attachments, inspect an image, or read a document's locally extracted text in pages. Use the returned offset to continue. Extracted text may omit images and layout.",
  schema,
  readOnly: true,
  concurrent: true,
  async execute(args, ctx) {
    const documents = ctx.attachments?.() ?? []
    if (!args.id) {
      return { content: documents.length ? documents.map((doc) => `${path.basename(doc.path).slice(0, 12)}  ${doc.name}`).join('\n') : 'This session has no attachments.' }
    }
    const matches = [...new Map(documents.filter((doc) => path.basename(doc.path).startsWith(args.id!)).map((doc) => [doc.path, doc])).values()]
    if (matches.length !== 1) return { content: matches.length ? 'That document ID is ambiguous; use a longer ID.' : 'That document is not attached to this session.', isError: true }
    const document = matches[0]!
    if (document.type === 'image') {
      if (!ctx.inspectAttachmentImage) return { content: 'Image inspection is unavailable in this context.', isError: true }
      return ctx.inspectAttachmentImage(document, args.question ?? 'Describe the image.')
    }
    try {
      const text = await readFile(`${document.path}.txt`, 'utf8')
      const offset = args.offset ?? 0
      if (offset > text.length) return { content: `Offset ${offset} is past the end of ${document.name} (${text.length} characters).`, isError: true }
      const end = Math.min(offset + 20_000, text.length)
      const continuation = end < text.length ? `\n[Continue with offset=${end}; ${text.length - end} characters remain.]` : ''
      return { content: `${document.name}, characters ${offset}–${end} of ${text.length}:\n${text.slice(offset, end)}${continuation}` }
    } catch (error) {
      return { content: `Could not read extracted text from ${document.name}: ${errorMessage(error)}`, isError: true }
    }
  },
}
