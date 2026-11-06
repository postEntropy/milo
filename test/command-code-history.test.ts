import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandCodeHistoryReader } from '../src/core/command-code-history.js'
import type { SessionRecord } from '../src/core/sessions/types.js'

const nativeSessionId = '7f83d2b4-a4ab-4e3a-8e6d-16d5cb2e9b20'
const fixture = new URL('./fixtures/command-code-session.jsonl', import.meta.url)
const homes: string[] = []

function projectHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'milo-command-code-history-'))
  homes.push(home)
  const directory = path.join(home, '.commandcode', 'projects', 'project-slug')
  mkdirSync(directory, { recursive: true })
  copyFileSync(fixture, path.join(directory, `${nativeSessionId}.jsonl`))
  return home
}

function record(nativeId = nativeSessionId): SessionRecord {
  return {
    id: 'calm-otter-7',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    messages: [],
    project: 'calm-otter-8',
    backend: {
      kind: 'command-code',
      state: 'ready',
      nativeSessionId: nativeId,
      nativeTitle: 'Milo Session calm-otter-7',
      workingDirectory: '/project',
      projectIncarnation: 'project-generation-1',
      requestId: 'web:chat-id',
    },
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('Command Code native history', () => {
  it('projects the active JSONL conversation without creating a Milo transcript', () => {
    const home = projectHome()
    const session = record()
    const history = new CommandCodeHistoryReader(home).read(session)

    expect(history.nativeSessionId).toBe(nativeSessionId)
    expect(history.preview).toBe('Create a source file.')
    expect(history.messageCount).toBe(2)
    expect(history.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(history.messages[1]?.content).toEqual([
      { type: 'reasoning', text: 'I will write the file.', signature: 'signature-1' },
      { type: 'text', text: 'Writing it now.' },
      { type: 'tool-call', id: 'call-1', name: 'write_file', args: { file_path: '/project/result.txt', content: 'hello' } },
    ])
    expect(history.messages[2]?.content).toEqual([
      { type: 'tool-result', id: 'call-1', name: 'write_file', content: 'Wrote 1 file.' },
    ])
    expect(history.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Done.' }])
    expect(session.messages).toEqual([])
  })

  it('rejects a transcript from another working directory', () => {
    const home = projectHome()
    const session = record()
    if (session.backend?.kind !== 'command-code') throw new Error('Expected a Command Code Session')
    session.backend.workingDirectory = '/another-project'

    expect(() => new CommandCodeHistoryReader(home).read(session)).toThrow(`was not found in /another-project` )
  })

  it('rejects a broken parent chain rather than drawing partial history as complete', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'milo-command-code-history-'))
    homes.push(home)
    const directory = path.join(home, '.commandcode', 'projects', 'project-slug')
    mkdirSync(directory, { recursive: true })
    const header = { type: 'session', version: 3, id: nativeSessionId, timestamp: '2026-11-05T12:00:00Z', cwd: '/project' }
    const orphan = {
      type: 'message',
      id: 'message-1',
      parentId: 'missing-parent',
      timestamp: '2026-11-05T12:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Hello.' }], meta: { source: 'user', createdAt: 1, messageId: 'user-1' } },
    }
    writeFileSync(path.join(directory, `${nativeSessionId}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(orphan)}\n`)

    expect(() => new CommandCodeHistoryReader(home).read(record())).toThrow('is missing parent missing-parent')
  })

  it('rejects native content the chat renderer cannot represent', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'milo-command-code-history-'))
    homes.push(home)
    const directory = path.join(home, '.commandcode', 'projects', 'project-slug')
    mkdirSync(directory, { recursive: true })
    const header = { type: 'session', version: 3, id: nativeSessionId, timestamp: '2026-11-05T12:00:00Z', cwd: '/project' }
    const user = {
      type: 'message',
      id: 'message-1',
      parentId: null,
      timestamp: '2026-11-05T12:00:01Z',
      message: { role: 'user', content: [{ type: 'image', data: 'native-image' }], meta: { source: 'user', createdAt: 1, messageId: 'user-1' } },
    }
    writeFileSync(path.join(directory, `${nativeSessionId}.jsonl`), `${JSON.stringify(header)}\n${JSON.stringify(user)}\n`)

    expect(() => new CommandCodeHistoryReader(home).read(record())).toThrow('user content block image is not supported')
  })
})
