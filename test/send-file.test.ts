import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  describeOutgoing,
  isImage,
  isTelegramPhoto,
  MAX_OUTGOING_BYTES,
  mimeFor,
} from '../src/core/outgoing.js'
import { sendFileTool } from '../src/core/tools/send-file.js'
import type { ToolContext } from '../src/core/tools/types.js'

const home = mkdtempSync(path.join(tmpdir(), 'milo-send-file-'))

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('describeOutgoing', () => {
  it('names the file and reads its type from the extension', () => {
    const file = path.join(home, 'shot.png')
    writeFileSync(file, 'x')

    expect(describeOutgoing(file)).toEqual({ path: file, name: 'shot.png', mimeType: 'image/png' })
    expect(describeOutgoing(file, '  the screen  ')).toMatchObject({ caption: 'the screen' })
    // An empty caption is not a caption: a blank line under a picture is noise.
    expect(describeOutgoing(file, '   ').caption).toBeUndefined()
  })

  it('refuses a path that is not there', () => {
    expect(() => describeOutgoing(path.join(home, 'nope.png'))).toThrow('no such file')
  })

  it('refuses a directory', () => {
    const dir = path.join(home, 'a-directory')
    mkdirSync(dir)
    expect(() => describeOutgoing(dir)).toThrow('not a file')
  })

  it('refuses a file past the ceiling', () => {
    const huge = path.join(home, 'huge.bin')
    const handle = openSync(huge, 'w')
    // Sparse: it is the size that is checked, so writing 50 MB of zeroes would
    // only make the test slow.
    ftruncateSync(handle, MAX_OUTGOING_BYTES + 1)
    closeSync(handle)
    expect(() => describeOutgoing(huge)).toThrow('the most that can be sent')
  })
})

describe('file kinds', () => {
  it('decides photo versus document, and unknown extensions', () => {
    expect(mimeFor('a.gif')).toBe('image/gif')
    expect(mimeFor('logo.SVG')).toBe('image/svg+xml')
    expect(mimeFor('thing.weird')).toBe('application/octet-stream')
    expect(isImage('image/gif')).toBe(true)
    expect(isImage('application/pdf')).toBe(false)
    // Telegram takes only PNG and JPEG as a photo; a GIF goes as a document.
    expect(isTelegramPhoto('image/jpeg')).toBe(true)
    expect(isTelegramPhoto('image/gif')).toBe(false)
  })
})

describe('the send_file tool', () => {
  it('says so when there is no chat to send to', async () => {
    const result = await sendFileTool.execute({ path: 'shot.png' }, context({}))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('no chat')
  })

  it('hands the file to the session, resolved against the working directory', async () => {
    const sent: { path: string; caption?: string }[] = []
    const result = await sendFileTool.execute({ path: 'shot.png', caption: 'hi' }, context({ sent }))

    expect(result.isError).toBeUndefined()
    expect(sent).toEqual([{ path: path.join(home, 'shot.png'), caption: 'hi' }])
    expect(result.content).toContain('Sent shot.png')
  })

  it('reports what the session refused, in words the model can act on', async () => {
    const result = await sendFileTool.execute({ path: '/x.png' }, context({ error: 'no such file: /x.png' }))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Could not send /x.png')
    expect(result.content).toContain('no such file')
  })
})

function context(options: { sent?: { path: string; caption?: string }[]; error?: string }): ToolContext {
  const ctx: ToolContext = { cwd: home, signal: new AbortController().signal }
  if (options.sent || options.error) {
    ctx.sendFile = async (input) => {
      if (options.error) throw new Error(options.error)
      options.sent!.push(input)
      return {
        path: input.path,
        name: path.basename(input.path),
        mimeType: 'image/png',
        ...(input.caption ? { caption: input.caption } : {}),
      }
    }
  }
  return ctx
}
