import { describe, expect, it } from 'vitest'
import { deriveFacts as deriveWithSources, reviewRememberDuplicates, type DeriveOptions } from '../src/core/memory/derive.js'

const deriveFacts = async (options: DeriveOptions): Promise<string[]> => (await deriveWithSources(options)).map((fact) => fact.text)
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
    const script = this.scripts[this.calls] ?? answered('KEEP 1\nKEEP 2')
    this.calls += 1
    for (const event of script) yield event
  }
}

describe('deriveFacts', () => {
  it('sends existing notes to the review and keeps a correction when the reviewer distinguishes it', async () => {
    const existing = [{ id: 'old', text: 'My editor is Vim', createdAt: 1 }]
    let observed = ''
    let calls = 0
    const provider: Provider = {
      id: 'comparison',
      async *stream(req): AsyncGenerator<StreamEvent> {
        calls++
        if (calls === 1) yield { type: 'text', delta: 'My editor is Emacs\tmy editor is Emacs' }
        else {
          observed = JSON.stringify(req.messages)
          yield { type: 'text', delta: 'KEEP 1' }
        }
      },
    }
    const result = await deriveWithSources({ provider, model: 'm', person: 'my editor is Emacs', messages: turn, existing: async () => existing })
    expect(result.map((item) => item.text)).toEqual(['My editor is Emacs'])
    expect(observed).toContain('My editor is Vim')
  })

  it('checks explicit remember requests and reports a failed comparison', async () => {
    const existing = [{ id: 'old', text: 'I use Vim', createdAt: 1 }]
    const items = [{ text: 'Vim is my editor' }, { text: 'My editor is Emacs now' }]
    const opts = { provider: new ScriptedProvider([answered('KEEP 2')]), model: 'm', person: 'Remember this', messages: turn }
    expect(await reviewRememberDuplicates(opts, items, existing)).toEqual([items[1]])
    expect(await reviewRememberDuplicates({ ...opts, provider: new ScriptedProvider([answered('unclear')]) }, items, existing)).toBeNull()
  })
  it('keeps the exact supporting quote and does not invent a quote for a normalized match', async () => {
    const exact = new ScriptedProvider([answered('Uses Neovim\tmy editor is Neovim')])
    expect(await deriveWithSources({ provider: exact, model: 'm', person: 'my editor is Neovim', messages: turn }))
      .toEqual([{ text: 'Uses Neovim', quote: 'my editor is Neovim' }])
    const normalized = new ScriptedProvider([answered('Uses Neovim\tMY EDITOR IS NEOVIM')])
    expect(await deriveWithSources({ provider: normalized, model: 'm', person: 'my editor is Neovim', messages: turn }))
      .toEqual([{ text: 'Uses Neovim' }])
  })
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

  it('keeps only candidates explicitly approved by the independent review', async () => {
    const provider = new ScriptedProvider([
      answered('Uses Neovim\tmy editor is Neovim\nThe site builds\tthe site builds'),
      answered('KEEP 1'),
    ])
    expect(await deriveFacts({ provider, model: 'm', person: 'my editor is Neovim; the site builds', messages: turn }))
      .toEqual(['Uses Neovim'])
  })

  it('keeps nothing if the review is missing or malformed', async () => {
    const provider = new ScriptedProvider([answered('Uses Neovim\tmy editor is Neovim'), answered('yes, keep it')])
    expect(await deriveFacts({ provider, model: 'm', person: 'my editor is Neovim', messages: turn })).toEqual([])
  })

  it('rejects review output containing commentary even alongside an approval', async () => {
    const provider = new ScriptedProvider([answered('Uses Neovim\tmy editor is Neovim'), answered('KEEP 1\nThis seems useful.')])
    expect(await deriveFacts({ provider, model: 'm', person: 'my editor is Neovim', messages: turn })).toEqual([])
  })

  it('reads NONE as a turn with nothing worth keeping', async () => {
    const provider = new ScriptedProvider([answered('NONE')])
    expect(await deriveFacts({ provider, model: 'm', person, messages: turn })).toEqual([])
  })

  it('keeps at most two facts from one turn', async () => {
    const said = Array.from({ length: 9 }, (_, i) => `fato numero ${i}`).join(', ')
    const provider = new ScriptedProvider([
      answered(
        Array.from({ length: 9 }, (_, i) => `fato numero ${i}\tfato numero ${i}`).join('\n'),
      ),
    ])
    expect(await deriveFacts({ provider, model: 'm', person: said, messages: turn })).toHaveLength(
      2,
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
        yield { type: 'text', delta: req.system?.startsWith('Review candidate') ? 'KEEP 1' : 'a versao atual e a 1\ta versao atual e a 1' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    // Cheap first, then compatible: a provider that does not know the field must
    // not mean nothing is ever extracted.
    expect(
      await deriveFacts({ provider, model: 'm', person: 'a versao atual e a 1', messages: turn }),
    ).toEqual(['a versao atual e a 1'])
    expect(asked).toEqual(['low', undefined, 'low', undefined])
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
