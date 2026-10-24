import { describe, expect, it } from 'vitest'
import { deriveFacts } from '../src/core/memory/derive.js'
import type { ChatRequest, Provider, ReasoningEffort, StreamEvent } from '../src/core/providers/types.js'

const person = 'meu editor e o Neovim, e prefiro bullet points'
const turn = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: person }] },
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
      answered(
        '- O editor do Renato e o Neovim\tmeu editor e o Neovim\n\n- Ele prefere bullet points\te prefiro bullet points',
      ),
    ])

    expect(await deriveFacts({ provider, model: 'm', person, messages: turn })).toEqual([
      'O editor do Renato e o Neovim',
      'Ele prefere bullet points',
    ])
  })

  it('reads NONE as a turn with nothing worth keeping', async () => {
    const provider = new ScriptedProvider([answered('NONE')])
    expect(await deriveFacts({ provider, model: 'm', person, messages: turn })).toEqual([])
  })

  it('keeps at most five facts from one turn', async () => {
    const said = Array.from({ length: 9 }, (_, i) => `fato numero ${i}`).join(', ')
    const provider = new ScriptedProvider([
      answered(
        Array.from({ length: 9 }, (_, i) => `fato numero ${i}\tfato numero ${i}`).join('\n'),
      ),
    ])
    expect(await deriveFacts({ provider, model: 'm', person: said, messages: turn })).toHaveLength(
      5,
    )
  })

  it('drops a fact with no words of the person to stand on', async () => {
    const provider = new ScriptedProvider([answered('O editor do Renato e o Neovim')])
    expect(await deriveFacts({ provider, model: 'm', person, messages: turn })).toEqual([])
  })

  it('keeps nothing the answer alone says about the person', async () => {
    const exchange = [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: 'e como é o port dos outros mods? da pra gente fazer?',
          },
        ],
      },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'text' as const,
            text: 'O pipeline porta os mods do ATM10 para o Horizon.',
          },
        ],
      },
    ]
    const provider = new ScriptedProvider([
      answered('Está portando os mods do ATM10 para o Horizon\tportando os mods'),
    ])

    expect(
      await deriveFacts({
        provider,
        model: 'm',
        person: 'e como é o port dos outros mods? da pra gente fazer?',
        messages: exchange,
      }),
    ).toEqual([])
  })

  it('accepts a faithful quote without matching accents or case', async () => {
    const provider = new ScriptedProvider([answered('O editor dele é o Neovim\tMeu EDITOR é o neovim')])
    expect(
      await deriveFacts({ provider, model: 'm', person: 'meu editor é o Neovim', messages: turn }),
    ).toEqual(['O editor dele é o Neovim'])
  })

  it('asks again without the effort hint when the provider rejects it', async () => {
    const asked: (ReasoningEffort | undefined)[] = []
    const provider: Provider = {
      id: 'picky',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        asked.push(req.reasoningEffort)
        if (req.reasoningEffort) throw new Error('unknown field: reasoning_effort')
        yield { type: 'text', delta: 'a versao atual e a 1\ta versao atual e a 1' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    // Cheap first, then compatible: a provider that does not know the field must
    // not mean nothing is ever extracted.
    expect(
      await deriveFacts({ provider, model: 'm', person: 'a versao atual e a 1', messages: turn }),
    ).toEqual(['a versao atual e a 1'])
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

    expect(await deriveFacts({ provider, model: 'm', person, messages: turn })).toEqual([])
  })

  it('asks only once when the attempt is cut off by its own budget', async () => {
    let calls = 0
    const provider: Provider = {
      id: 'slow',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        calls += 1
        await new Promise<void>((resolve) =>
          req.signal?.addEventListener('abort', () => resolve(), { once: true }),
        )
        throw new Error('This operation was aborted')
      },
    }

    expect(
      await deriveFacts({ provider, model: 'm', person, messages: turn, timeoutMs: 10 }),
    ).toEqual([])
    // The retry is for a provider that rejects the effort field, not for a call
    // that ran out of time: asking again would be cut off at the same budget.
    expect(calls).toBe(1)
  })

  it('tells the extractor to leave out numbers that will change', async () => {
    let system = ''
    const provider: Provider = {
      id: 'capture',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        system = req.system ?? ''
        yield { type: 'text', delta: 'NONE' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    await deriveFacts({ provider, model: 'm', person, messages: turn })
    expect(system).toMatch(/measurement|version|number/i)
  })

  it('tells the extractor to leave the assistant and its questions out', async () => {
    let system = ''
    const provider: Provider = {
      id: 'capture',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        system = req.system ?? ''
        yield { type: 'text', delta: 'NONE' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    await deriveFacts({ provider, model: 'm', person, messages: turn })
    expect(system).toMatch(/assistant/i)
    expect(system).toMatch(/question/i)
    expect(system).toMatch(/NONE/)
  })
})
