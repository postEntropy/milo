import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveCommandCodeAttachments } from '../src/core/command-code-attachments.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'milo-command-code-attachments-'))
  roots.push(directory)
  return directory
}

describe('Command Code attachments', () => {
  it('writes collision-safe files in the project and returns relative paths', async () => {
    const root = temporaryDirectory()
    const project = path.join(root, 'project')
    mkdirSync(project)
    const files = [
      { name: '../../report.txt', mimeType: 'text/plain', data: Buffer.from('one') },
      { name: 'report.txt', mimeType: 'text/plain', data: Buffer.from('two') },
    ]

    const paths = await saveCommandCodeAttachments(project, 'calm-otter-7', files)

    expect(paths).toHaveLength(2)
    expect(paths.every((file) => file.startsWith('.milo-attachments/calm-otter-7/'))).toBe(true)
    expect(new Set(paths).size).toBe(2)
    expect(paths.map((file) => readFileSync(path.join(project, file), 'utf8'))).toEqual(['one', 'two'])
    expect(paths.map((file) => statSync(path.join(project, file)).mode & 0o777)).toEqual([0o600, 0o600])
  })

  it('refuses an attachment directory that resolves outside the project', async () => {
    const root = temporaryDirectory()
    const project = path.join(root, 'project')
    const outside = path.join(root, 'outside')
    mkdirSync(project)
    mkdirSync(outside)
    symlinkSync(outside, path.join(project, '.milo-attachments'))

    await expect(saveCommandCodeAttachments(project, 'calm-otter-7', [
      { name: 'secret.txt', mimeType: 'text/plain', data: Buffer.from('secret') },
    ])).rejects.toThrow('must stay inside the Work project')
    expect(readdirSync(outside)).toEqual([])
  })

  it('rejects empty attachments', async () => {
    const project = temporaryDirectory()
    await expect(saveCommandCodeAttachments(project, 'calm-otter-7', [
      { name: 'empty.txt', mimeType: 'text/plain', data: Buffer.alloc(0) },
    ])).rejects.toThrow('is empty')
  })
})
