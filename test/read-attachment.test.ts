import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAttachmentTool } from '../src/core/tools/read-attachment.js'
import type { ToolContext } from '../src/core/tools/types.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'milo-attachment-'))
const file = path.join(dir, 'abcdef1234567890')
writeFileSync(`${file}.txt`, `${'a'.repeat(20_000)}the ending`)
const ctx: ToolContext = {
  cwd: dir,
  signal: new AbortController().signal,
  attachments: () => [{ type: 'document', name: 'report.txt', mimeType: 'text/plain', path: file }],
}

describe('reading an attachment', () => {
  it('lists this session’s documents and pages through the full extracted text', async () => {
    expect((await readAttachmentTool.execute({}, ctx)).content).toContain('abcdef123456  report.txt')
    expect((await readAttachmentTool.execute({ id: 'abcdef123456' }, ctx)).content).toContain('Continue with offset=20000')
    expect((await readAttachmentTool.execute({ id: 'abcdef123456', offset: 20_000 }, ctx)).content).toContain('the ending')
  })

  it('uses the session image reader for pictures', async () => {
    const imageCtx: ToolContext = {
      ...ctx,
      attachments: () => [{ type: 'image', name: 'photo.png', mimeType: 'image/png', path: file }],
      inspectAttachmentImage: async (_image, question) => ({ content: `Looked for ${question}` }),
    }
    const result = await readAttachmentTool.execute({ id: 'abcdef123456', question: 'the sign' }, imageCtx)
    expect(result.content).toBe('Looked for the sign')
  })

  it('refuses a document outside the session', async () => {
    const result = await readAttachmentTool.execute({ id: '../secret' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not attached')
  })
})
