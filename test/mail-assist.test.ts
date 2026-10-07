import { describe, expect, it } from 'vitest'
import { emailAssist } from '../src/core/google/assist.js'
import type { Provider } from '../src/core/providers/types.js'

/** The part of the request this test reads back: the instruction the mode chose. */
type StreamRequest = { system?: string }

/** A provider that answers with `text`, and records the instructions it was given. */
function provider(text: string, seen: string[] = []): Provider {
  return {
    id: 'fake',
    stream: async function* (request: StreamRequest) {
      seen.push(request.system ?? '')
      if (text) yield { type: 'text', delta: text }
    },
  } as unknown as Provider
}

describe('the mail assistant', () => {
  it('answers with the model text, trimmed', async () => {
    const got = await emailAssist({
      provider: provider('  Nothing needs you.\n'),
      model: 'm',
      mode: 'triage',
      mail: '- ana — a nota',
    })
    expect(got).toEqual({ ok: true, text: 'Nothing needs you.' })
  })

  it('treats an empty answer as a failure, not as a quiet nothing', async () => {
    const got = await emailAssist({ provider: provider('   '), model: 'm', mode: 'summarize', mail: 'x' })
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.error).toContain('nothing')
  })

  it('asks each mode with its own instruction', async () => {
    const seen: string[] = []
    await emailAssist({ provider: provider('ok', seen), model: 'm', mode: 'draft', mail: 'x' })
    expect(seen[0]).toContain("recipient's own voice")
  })

  it('says so, rather than failing silently, when the model cannot be reached', async () => {
    const broken = {
      id: 'fake',
      // Throws as the call is made, which is where the assistant has to catch it.
      stream: (): never => {
        throw new Error('connection reset')
      },
    } as unknown as Provider
    const got = await emailAssist({ provider: broken, model: 'm', mode: 'triage', mail: 'x' })
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.error).toContain('connection reset')
  })
})
