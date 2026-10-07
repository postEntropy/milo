import { afterEach, describe, expect, it, vi } from 'vitest'
import { Classifier, DANGER_QUESTION, createClassifier, dangerousReviewer } from '../src/core/classifier/index.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

const answering = (noul: number) =>
  vi.fn(
    async (_input: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ answers: { dangerous: { noul } } }), { status: 200 }),
  )

describe('Classifier', () => {
  it('posts a typed noul question and parses the probability', async () => {
    const fetchMock = answering(0.93)
    vi.stubGlobal('fetch', fetchMock)

    const classifier = new Classifier({
      baseURL: 'https://api.commandcode.ai/provider/v1',
      apiKey: 'k',
    })
    const probability = await classifier.reviewDanger('Command to run:\nrm -rf /')

    expect(probability).toBeCloseTo(0.93)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.commandcode.ai/provider/v1/systemone',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer k' }),
      }),
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.model).toBe('typesafe/jev')
    expect(body.questions.dangerous.type).toBe('noul')
    expect(body.state).toContain('rm -rf /')
  })

  it('asks the model it is given, so a local backend names its own', async () => {
    const fetchMock = answering(0.2)
    vi.stubGlobal('fetch', fetchMock)

    await createClassifier({ baseURL: 'http://127.0.0.1:11435/v1', model: 'winnow:e4b' }).reviewDanger('s')

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.model).toBe('winnow:e4b')
  })

  it('speaks the OpenAI Decisions wire when asked to', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ answers: [{ type: 'predicate', name: 'dangerous', probability: 0.87 }] }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const classifier = new Classifier({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'k',
      wire: 'openai',
    })
    expect(await classifier.reviewDanger('rm -rf /')).toBeCloseTo(0.87)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.openai.com/v1/decisions',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer k' }),
      }),
    )
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.model).toBe('gpt-6-luna')
    expect(body.input).toContain('rm -rf /')
    expect(body.questions).toEqual([
      { type: 'predicate', name: 'dangerous', instructions: expect.any(String) },
    ])
  })

  it('lists a choice question and its options for the Decisions API', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            answers: [{ type: 'choice', name: 'department', choice: 'billing', confidence: 0.9 }],
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const answers = await new Classifier({ baseURL: 'https://x.test/v1', wire: 'openai' }).ask(
      'a complaint',
      {
        department: {
          type: 'choice',
          instructions: 'Which department?',
          criteria: { billing: 'Payments.', shipping: 'Delivery.' },
        },
      },
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.questions[0]).toEqual({
      type: 'choice',
      name: 'department',
      instructions: 'Which department?',
      choices: [
        { value: 'billing', description: 'Payments.' },
        { value: 'shipping', description: 'Delivery.' },
      ],
    })
    expect(answers.department).toMatchObject({ choice: 'billing' })
  })

  it('lists a score question and its ordered levels for the Decisions API', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ answers: [{ type: 'score', name: 'urgency', score: 1.4 }] }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const answers = await new Classifier({ baseURL: 'https://x.test/v1', wire: 'openai' }).ask(
      'a ticket',
      {
        urgency: {
          type: 'score',
          instructions: 'How urgent is this?',
          criteria: ['can wait', 'this week', 'blocking'],
        },
      },
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.questions[0]).toEqual({
      type: 'score',
      name: 'urgency',
      instructions: 'How urgent is this?',
      levels: [{ label: 'can wait' }, { label: 'this week' }, { label: 'blocking' }],
    })
    expect(answers.urgency).toMatchObject({ score: 1.4 })
  })

  it('fails closed when the decision model refuses to answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ answers: [{ type: 'refusal', name: 'dangerous' }] }), {
            status: 200,
          }),
      ),
    )

    await expect(
      new Classifier({ baseURL: 'https://x.test/v1', wire: 'openai' }).reviewDanger('s'),
    ).rejects.toThrow(/refused/)
  })

  it('sends no authorization header without a key', async () => {
    const fetchMock = answering(0.1)
    vi.stubGlobal('fetch', fetchMock)

    await new Classifier({ baseURL: 'http://127.0.0.1:11435/v1' }).reviewDanger('s')

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.authorization).toBeUndefined()
  })

  it('clamps out-of-range probabilities', async () => {
    vi.stubGlobal('fetch', answering(1.7))
    const classifier = new Classifier({ baseURL: 'https://x.test/v1' })
    expect(await classifier.reviewDanger('s')).toBe(1)
  })

  it('serves identical states from the cache', async () => {
    const fetchMock = answering(0.1)
    vi.stubGlobal('fetch', fetchMock)

    const classifier = new Classifier({ baseURL: 'https://x.test/v1' })
    await classifier.reviewDanger('same state')
    await classifier.reviewDanger('same state')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('bypasses the cache when disabled', async () => {
    const fetchMock = answering(0.1)
    vi.stubGlobal('fetch', fetchMock)

    const classifier = new Classifier({ baseURL: 'https://x.test/v1', cache: false })
    await classifier.reviewDanger('same state')
    await classifier.reviewDanger('same state')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(new Classifier({ baseURL: 'https://x.test/v1' }).reviewDanger('s')).rejects.toThrow(/401/)
  })

  it('throws when the answer carries no probability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })),
    )
    await expect(new Classifier({ baseURL: 'https://x.test/v1' }).reviewDanger('s')).rejects.toThrow(
      /no probability/,
    )
  })

  it('aborts instead of hanging when the request exceeds the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )

    const classifier = new Classifier({ baseURL: 'https://x.test/v1', timeoutMs: 20 })
    await expect(classifier.reviewDanger('slow')).rejects.toThrow()
  })

  it('lets one call override the instance timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return new Response(JSON.stringify({ answers: { dangerous: { noul: 0.5 } } }), { status: 200 })
      }),
    )

    // The instance would abort at 5ms; this call asks for longer and gets its answer.
    const classifier = new Classifier({ baseURL: 'https://x.test/v1', timeoutMs: 5 })
    const answers = await classifier.ask('slow-ish', { dangerous: DANGER_QUESTION }, undefined, 1_000)
    expect(answers.dangerous).toMatchObject({ noul: 0.5 })
  })

  it('hands the permission layer a one-number reviewer', async () => {
    vi.stubGlobal('fetch', answering(0.4))
    const reviewer = dangerousReviewer(new Classifier({ baseURL: 'https://x.test/v1' }))
    expect(await reviewer.review('rm -rf /')).toBeCloseTo(0.4)
  })
})
