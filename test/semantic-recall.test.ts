import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Embedder } from '../src/core/memory/embed.js'
import { InputRefusedError } from '../src/core/memory/embed.js'
import { createMemory } from '../src/core/memory/index.js'
import { SqliteMemory } from '../src/core/memory/sqlite.js'

let open: Server | null = null

afterEach(() => {
  open?.close()
  open = null
})

/**
 * A stand-in for an embedding model: it puts a text on the axis of the subject
 * the text is about. "codar" and "editor" land on the same axis while sharing no
 * letter, which is what a keyword store cannot do — and what makes the
 * zero-overlap case below observable rather than merely asserted.
 */
const SUBJECTS: Record<string, string[]> = {
  editing: ['editor', 'neovim', 'codar', 'edito', 'arquivos', 'codigo', 'vim'],
  release: ['tag', 'release', 'versao'],
  weather: ['tempo', 'chuva', 'sol'],
}

function vectorFor(text: string): Float32Array {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u)
  return Float32Array.from(
    Object.values(SUBJECTS).map((terms) => (terms.some((term) => words.includes(term)) ? 1 : 0)),
  )
}

function fakeEmbedder(model = 'fake-1'): Embedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    model,
    calls,
    async embed(texts) {
      calls.push([...texts])
      return texts.map(vectorFor)
    },
  }
}

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'milo-semantic-'))
const scope = { gateway: 'cli', conversationId: 'semantic' }

describe('recall by meaning', () => {
  it('finds a note that shares no word with the question', async () => {
    const dir = tempDir()
    // The same note in two stores: one with an engine, one without.
    const withVectors = new SqliteMemory({ dir: path.join(dir, 'with'), embedder: fakeEmbedder() })
    const wordsOnly = new SqliteMemory({ dir: path.join(dir, 'without') })
    const text = 'Meu editor e o Neovim.'
    await withVectors.remember(scope, [{ text }])
    await wordsOnly.remember(scope, [{ text }])

    // The case that made embeddings necessary: not a worse ranking, no ranking.
    expect(await wordsOnly.recall(scope, 'o que eu uso pra codar?')).toEqual([])

    const hits = await withVectors.recall(scope, 'o que eu uso pra codar?')
    expect(hits.some((hit) => hit.text.includes('Neovim'))).toBe(true)

    withVectors.close()
    wordsOnly.close()
  })

  it('keeps the words working on their own', async () => {
    const memory = new SqliteMemory({ dir: tempDir(), embedder: fakeEmbedder() })
    await memory.remember(scope, [{ text: 'A tag de release e a v0.1.0.' }])

    // Found by keyword and by vector both; either one would be enough.
    const hits = await memory.recall(scope, 'qual a tag de release?')
    expect(hits[0]!.text).toContain('release')
    memory.close()
  })

  it('falls back to words when the engine is not there', async () => {
    const broken: Embedder = {
      model: 'broken',
      embed: async () => {
        throw new Error('connection refused')
      },
    }
    const memory = new SqliteMemory({ dir: tempDir(), embedder: broken })
    await memory.remember(scope, [{ text: 'Meu editor e o Neovim.' }])

    // The note was written even though it could not be embedded, and the question
    // is answered by the words that are there.
    const hits = await memory.recall(scope, 'qual editor voce usa?')
    expect(hits.some((hit) => hit.text.includes('Neovim'))).toBe(true)
    memory.close()
  })

  it('re-embeds everything when the model changes', async () => {
    const dir = tempDir()
    const memory = new SqliteMemory({ dir, embedder: fakeEmbedder('fake-1') })
    await memory.remember(scope, [{ text: 'Meu editor e o Neovim.' }])
    memory.close()

    // A different model is a different space: the old vectors are not comparable
    // with the new ones, so they are thrown away and written again.
    const second = fakeEmbedder('fake-2')
    const reopened = new SqliteMemory({ dir, embedder: second })
    await reopened.whenEmbedded()

    expect(second.calls.flat()).toContain('Meu editor e o Neovim.')
    expect((await reopened.recall(scope, 'o que eu uso pra codar?')).length).toBeGreaterThan(0)
    reopened.close()
  })

  it('tries the fill-in again when the engine was not listening yet', async () => {
    const dir = tempDir()
    const first = new SqliteMemory({ dir, embedder: fakeEmbedder('fake-1') })
    await first.remember(scope, [{ text: 'Meu editor e o Neovim.' }])
    first.close()

    // A different model name makes the store rewrite every vector on open, and
    // the first attempt fails the way a starting engine does. Giving up there
    // would leave the whole store without vectors until the next run.
    let calls = 0
    const starting: Embedder = {
      model: 'fake-2',
      async embed(texts) {
        calls += 1
        if (calls === 1) throw new Error('connection refused')
        return texts.map(vectorFor)
      },
    }

    const reopened = new SqliteMemory({ dir, embedder: starting })
    await reopened.whenEmbedded()

    expect(calls).toBeGreaterThan(1)
    expect((await reopened.recall(scope, 'o que eu uso pra codar?')).length).toBeGreaterThan(0)
    reopened.close()
  })

  it('builds the hosted embedder out of the config, key and all', async () => {    const keys: (string | undefined)[] = []
    const server = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString()
      })
      request.on('end', () => {
        keys.push(request.headers.authorization)
        const body = JSON.parse(raw || '{}') as { input?: string[] }
        const data = (body.input ?? []).map((text) => ({ embedding: [...vectorFor(text)] }))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data }))
      })
    })
    open = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0

    // The whole path a person takes: a config naming the provider, and the key
    // that is already there for chat.
    const memory = createMemory(
      {
        derive: false,
        embedding: {
          provider: 'openrouter',
          model: 'liquid/lfm-2.5-embedding-350m:free',
          url: `http://127.0.0.1:${port}`,
        },
      },
      tempDir(),
      { apiKey: 'sk-or-test' },
    )

    await memory.remember(scope, [{ text: 'Meu editor e o Neovim.' }])
    const hits = await memory.recall(scope, 'o que eu uso pra codar?')

    expect(hits.some((hit) => hit.text.includes('Neovim'))).toBe(true)
    expect(keys).toContain('Bearer sk-or-test')
  })

  it('has no similarity cut-off, because none separates the two', async () => {
    const memory = new SqliteMemory({ dir: tempDir(), embedder: fakeEmbedder() })
    await memory.remember(scope, [{ text: 'Meu editor e o Neovim.' }])

    // A question about something else entirely, sharing no word and no subject.
    // The nearest note comes back anyway — measured against two real models the
    // bands overlapped (right notes 0.01–0.70, wrong ones 0.05–0.31), so a cut-off
    // either loses a correct answer or keeps an unrelated one. This is the
    // decided behaviour, recorded so nobody adds a threshold back by reflex.
    expect((await memory.recall(scope, 'como esta o tempo hoje?')).length).toBeGreaterThan(0)
    memory.close()
  })

  it('sends the head of a long note, not the whole thing', async () => {
    const seen: string[] = []
    const watching: Embedder = {
      model: 'watching',
      async embed(texts) {
        seen.push(...texts)
        return texts.map(vectorFor)
      },
    }
    const memory = new SqliteMemory({ dir: tempDir(), embedder: watching })

    // A pasted log for a turn: the smallest models refuse the whole request over
    // it — measured live, 1,803 tokens against a model that takes 512.
    await memory.remember(scope, [{ text: 'x'.repeat(5_000) }])

    expect(seen[0]!.length).toBeLessThanOrEqual(900)
    memory.close()
  })

  it('does not let one note the model refuses cost the others', async () => {
    const picky: Embedder = {
      model: 'picky',
      async embed(texts) {
        // What a provider says when the input itself is the problem.
        if (texts.some((text) => text.includes('POISON'))) {
          throw new InputRefusedError('400: too many tokens')
        }
        return texts.map(vectorFor)
      },
    }
    const memory = new SqliteMemory({ dir: tempDir(), embedder: picky })

    // One request, two notes, one of which the model will not take.
    await memory.remember(scope, [
      { text: 'POISON o que eu uso pra codar' },
      { text: 'Meu editor e o Neovim.' },
    ])
    await memory.whenEmbedded()

    // The one it would take went in, and the one it refused is left behind rather
    // than offered again on every run — which would block the whole store.
    expect(
      (await memory.recall(scope, 'o que eu uso pra codar?')).some((hit) =>
        hit.text.includes('Neovim'),
      ),
    ).toBe(true)
    memory.close()
  })
})
