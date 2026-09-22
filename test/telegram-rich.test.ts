import { describe, expect, it } from 'vitest'
import { RichMessenger, isNotModified, type RichSender } from '../src/gateways/telegram/rich'

interface Behaviour {
  richFails?: boolean
  editRichFails?: boolean
  editPlainFails?: boolean
}

function fakeSender(behaviour: Behaviour = {}) {
  const calls: string[] = []
  const sender: RichSender = {
    sendRich: async () => {
      calls.push('sendRich')
      if (behaviour.richFails) throw new Error('rich messages not supported')
      return 11
    },
    sendPlain: async () => {
      calls.push('sendPlain')
      return 22
    },
    editRich: async () => {
      calls.push('editRich')
      if (behaviour.editRichFails) throw new Error('cannot parse entities')
    },
    editPlain: async () => {
      calls.push('editPlain')
      if (behaviour.editPlainFails) throw new Error('message is not modified')
    },
  }
  return { sender, calls }
}

describe('RichMessenger', () => {
  it('posts a rich message when the API accepts it', async () => {
    const { sender, calls } = fakeSender()
    const id = await new RichMessenger(sender).post('1', 'hi')
    expect(id).toBe(11)
    expect(calls).toEqual(['sendRich'])
  })

  it('falls back to plain text when rich is refused', async () => {
    const { sender, calls } = fakeSender({ richFails: true })
    const id = await new RichMessenger(sender).post('1', 'hi')
    expect(id).toBe(22)
    expect(calls).toEqual(['sendRich', 'sendPlain'])
  })

  it('stays plain for the rest of the message after a rich failure', async () => {
    const { sender, calls } = fakeSender({ richFails: true })
    const messenger = new RichMessenger(sender)
    await messenger.post('1', 'a')
    await messenger.edit('1', 22, 'b')

    expect(calls).toEqual(['sendRich', 'sendPlain', 'editPlain'])
    expect(messenger.usingRich).toBe(false)
  })

  it('edits rich while it works', async () => {
    const { sender, calls } = fakeSender()
    const messenger = new RichMessenger(sender)
    await messenger.edit('1', 11, 'a')
    await messenger.edit('1', 11, 'b')
    expect(calls).toEqual(['editRich', 'editRich'])
    expect(messenger.usingRich).toBe(true)
  })

  it('degrades to plain edits when a rich edit fails, and stays there', async () => {
    const { sender, calls } = fakeSender({ editRichFails: true })
    const messenger = new RichMessenger(sender)
    await messenger.edit('1', 11, 'a')
    await messenger.edit('1', 11, 'b')

    expect(calls).toEqual(['editRich', 'editPlain', 'editPlain'])
    expect(messenger.usingRich).toBe(false)
  })

  it('lets an edit failure surface so the caller can swallow it', async () => {
    const { sender } = fakeSender({ editRichFails: true, editPlainFails: true })
    await expect(new RichMessenger(sender).edit('1', 11, 'a')).rejects.toThrow(/not modified/)
  })

  it('reset() turns rich back on for the next turn', async () => {
    const { sender, calls } = fakeSender({ richFails: true })
    const messenger = new RichMessenger(sender)
    await messenger.post('1', 'a')
    expect(messenger.usingRich).toBe(false)

    messenger.reset()
    await messenger.post('1', 'b')
    expect(calls).toEqual(['sendRich', 'sendPlain', 'sendRich', 'sendPlain'])
  })
})

describe('isNotModified', () => {
  it('recognises the benign edit error', () => {
    expect(isNotModified({ description: 'Bad Request: message is not modified' })).toBe(true)
  })

  it('ignores anything else', () => {
    expect(isNotModified(new Error('cannot parse entities'))).toBe(false)
    expect(isNotModified(undefined)).toBe(false)
  })
})
