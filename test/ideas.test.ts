import { describe, expect, it } from 'vitest'
import { deriveIdeas, type IdeaInput } from '../src/core/ideas.js'
import type { ChatRequest, Provider, StreamEvent } from '../src/core/providers/types.js'

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

const input = (provider: Provider, over: Partial<IdeaInput> = {}): IdeaInput => ({
  provider,
  model: 'm',
  notes: ['prefers concise answers'],
  sessions: [],
  ...over,
})

describe('deriveIdeas', () => {
  it('reads one idea per line, as a title and the message it would send', async () => {
    const provider = new ScriptedProvider([
      answered('Investigate the deploy | Why did the deploy fail last night?\nTidy the memory | Help me clean up what you remember.'),
    ])

    expect(await deriveIdeas(input(provider))).toEqual([
      { title: 'Investigate the deploy', prompt: 'Why did the deploy fail last night?' },
      { title: 'Tidy the memory', prompt: 'Help me clean up what you remember.' },
    ])
  })

  it('drops lines that are not in the shape, and blank ones', async () => {
    const provider = new ScriptedProvider([
      answered('\n- No pipe here\nPlan a change | Help me plan this.\nA title with nothing after |\n'),
    ])

    expect(await deriveIdeas(input(provider))).toEqual([
      { title: 'Plan a change', prompt: 'Help me plan this.' },
    ])
  })

  it('reads NONE as nothing worth offering', async () => {
    const provider = new ScriptedProvider([answered('NONE')])
    expect(await deriveIdeas(input(provider))).toEqual([])
  })

  it('keeps at most four ideas', async () => {
    const provider = new ScriptedProvider([
      answered(Array.from({ length: 9 }, (_, index) => `Idea ${index} | Do thing ${index}`).join('\n')),
    ])
    expect(await deriveIdeas(input(provider))).toHaveLength(4)
  })

  it('keeps nothing, and does not throw, when the provider fails outright', async () => {
    const provider: Provider = {
      id: 'broken',
      // biome-ignore lint/correctness/useYield: a provider that fails right away yields nothing
      async *stream(): AsyncGenerator<StreamEvent> {
        throw new Error('provider exploded')
      },
    }

    expect(await deriveIdeas(input(provider))).toEqual([])
  })

  it('asks again without the effort hint when the provider rejects it', async () => {
    const asked: (string | undefined)[] = []
    const provider: Provider = {
      id: 'picky',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        asked.push(req.reasoningEffort)
        if (req.reasoningEffort) throw new Error('unknown field: reasoning_effort')
        yield { type: 'text', delta: 'Plan a change | Help me plan this.' }
        yield { type: 'done', finishReason: 'stop' }
      },
    }

    // Cheap first, then compatible: a provider that does not know the field must
    // not mean no ideas are ever offered.
    expect(await deriveIdeas(input(provider))).toEqual([
      { title: 'Plan a change', prompt: 'Help me plan this.' },
    ])
    expect(asked).toEqual(['low', undefined])
  })

  it('drops a call that runs out of its own budget, and does not ask again', async () => {
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

    expect(await deriveIdeas(input(provider, { timeoutMs: 10 }))).toEqual([])
    // The retry is for a provider that rejects the effort field, not for a call
    // that ran out of time: asking again would be cut off at the same budget.
    expect(calls).toBe(1)
  })

  it('keeps nothing when the turn it belongs to is cancelled', async () => {
    const controller = new AbortController()
    const provider: Provider = {
      id: 'waiting',
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        await new Promise<void>((resolve) =>
          req.signal?.addEventListener('abort', () => resolve(), { once: true }),
        )
        throw new Error('This operation was aborted')
      },
    }

    const pending = deriveIdeas(input(provider, { signal: controller.signal }))
    controller.abort()
    expect(await pending).toEqual([])
  })
})
