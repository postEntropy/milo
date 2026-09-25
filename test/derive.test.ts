import { describe, expect, it } from 'vitest'
import { deriveFacts } from '../src/core/memory/derive.js'
import type { ChatRequest, Provider, ReasoningEffort, StreamEvent } from '../src/core/providers/types.js'

const turn = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'meu editor e o Neovim' }] },
  { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'anotado' }] },
]

const answered = (text: string): StreamEvent[] => [
  { type: 'text', delta: text },
  { type: 'done', finishReason: 'stop' },
]

class ScriptedProvider implements Provider {
  readonly id = 'scripted'
  private calls = 0
  constructor(private readonly scripts: StreamEvent[][]) {}

  async *stream(): AsyncGenerator<StreamEvent> {
    const script = this.scripts[this.calls] ?? [{ type: 'done', finishReason: 'stop' as const }]
    this.calls += 1
    for (const event of script) yield event
  }
}

describe('deriveFacts', () => {
  it('reads one fact per line, bullets and blank lines aside', async () => {
    const provider = new ScriptedProvider([
      answered('- O editor do Renato e o Neovim\n\n- Ele prefere bullet points'),
    ])

    expect(await deriveFacts({ provider, model: 'm', messages: turn })).toEqual([
      'O editor do Renato e o Neovim',
      'Ele prefere bullet points',
    ])
  })

  it('reads NONE as a turn with nothing worth keeping', async () => {
    const provider = new ScriptedProvider([answered('NONE')])
    expect(await deriveFacts({ provider, model: 'm', messages: turn })).toEqual([])
  })

  it('keeps at most five facts from one turn', async () => {
    const provider = new ScriptedProvider([
      answered(Array.from({ length: 9 }, (_, i) => `fato numero ${i}`).join('\n')),
    ])
    expect(await deriveFacts({ provider, model: 'm', messages: turn })).toHaveLength(5)
  })

  it('asks again without the effort hint when the provider rejects it', async () => {
    const asked: (ReasoningEffort | undefined)[] = []
    const provider: Provider = {
      id: 'picky',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        asked.push(req.reasoningEffort)
        if (req.reasoningEffort) throw new Error('unknown field: reasoning_effort')
        yield { type: 'text', delta: 'a versao atual e a 1' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    // Cheap first, then compatible: a provider that does not know the field must
    // not mean nothing is ever extracted.
    expect(await deriveFacts({ provider, model: 'm', messages: turn })).toEqual([
      'a versao atual e a 1',
    ])
    expect(asked).toEqual(['low', undefined])
  })

  it('keeps nothing, and does not throw, when the provider fails outright', async () => {
    const provider: Provider = {
      id: 'broken',
      // biome-ignore lint/correctness/useYield: a provider that fails right away yields nothing
      async *stream(): AsyncGenerator<StreamEvent> {
        throw new Error('provider exploded')
      },
    }

    expect(await deriveFacts({ provider, model: 'm', messages: turn })).toEqual([])
  })
})
