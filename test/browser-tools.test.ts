import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createBrowserTools } from '../src/core/browser/tools.js'
import type { ActRequest, BrowserSession } from '../src/core/browser/session.js'
import { mergeObservations, type Observation, type RawElement } from '../src/core/browser/observer.js'
import { createToolRegistry } from '../src/core/tools/index.js'
import type { Tool, ToolContext } from '../src/core/tools/types.js'

const page: Observation = mergeObservations([
  {
    url: 'https://example.com/',
    title: 'Example',
    heading: 'Hello',
    text: 'Words.',
    textTruncated: false,
    frame: 'main',
    elements: [{ ref: 'r1', role: 'button', name: 'Go', state: '', sensitive: null }],
    more: false,
  },
])

const context = (): ToolContext => ({ cwd: '/work', signal: new AbortController().signal })

function stub(options: { elements?: Record<string, RawElement>; throws?: string } = {}) {
  const actions: ActRequest[] = []
  const observed: { observe?: boolean }[] = []
  const session = {
    elementFor: (ref: string) => options.elements?.[ref],
    navigate: async () => page,
    observe: async () => page,
    readText: async () => ({ url: 'https://example.com/', title: 'Example', text: 'a'.repeat(50_000), truncated: true }),
    screenshot: async () => 'ZmFrZQ==',
    act: async (request: ActRequest, _signal: AbortSignal, actOptions: { observe?: boolean } = {}) => {
      if (options.throws) throw new Error(options.throws)
      actions.push(request)
      observed.push(actOptions)
      return actOptions.observe === false ? { note: 'did it' } : { note: 'did it', observation: page }
    },
  }
  const tools = createBrowserTools(session as unknown as BrowserSession)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  return { tools, byName, actions, observed }
}

const run = async (tool: Tool<unknown>, args: unknown, ctx = context()) => tool.execute(args, ctx)

describe('the browser toolset', () => {
  it('is three tools, two of them free to run', () => {
    const { tools, byName } = stub()
    expect(tools.map((tool) => tool.name)).toEqual([
      'browser_open',
      'browser_snapshot',
      'browser_screenshot',
      'browser_act',
    ])
    expect(byName.get('browser_open')!.readOnly).toBe(true)
    expect(byName.get('browser_snapshot')!.readOnly).toBe(true)
    // Acting is where the side effect is, so it is the one that asks.
    expect(byName.get('browser_act')!.readOnly).toBeUndefined()
    // And so does writing a picture: it was a mode of the read-only snapshot
    // until someone noticed a write the policy was never asked about.
    expect(byName.get('browser_screenshot')!.readOnly).toBeUndefined()
  })

  it('is registered only when there is a browser behind it', () => {
    const { byName } = stub()
    const session = {} as BrowserSession
    expect(createToolRegistry({ browser: session }).has('browser_act')).toBe(true)
    expect(createToolRegistry({ browser: null }).has('browser_act')).toBe(false)
    expect(createToolRegistry({}).list().map((tool) => tool.name)).not.toContain('browser_open')
    void byName
  })
})

describe('browser_open', () => {
  it('refuses anything that is not http(s)', async () => {
    const { byName } = stub()
    const result = await run(byName.get('browser_open')!, { url: 'file:///etc/passwd' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('only http and https')
  })

  it('refuses something that is not a URL at all', async () => {
    const { byName } = stub()
    const result = await run(byName.get('browser_open')!, { url: 'not a url' })
    expect(result.isError).toBe(true)
  })

  it('refuses a cloud metadata address', async () => {
    // Opening is read-only and never asks, so an address that hands back the
    // machine's credentials must be barred at the tool, not left to the page.
    const { byName } = stub()
    const result = await run(byName.get('browser_open')!, { url: 'http://169.254.169.254/latest/meta-data/' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('metadata address')
  })

  it('still opens loopback, which a dev server needs', async () => {
    const { byName } = stub()
    const result = await run(byName.get('browser_open')!, { url: 'http://127.0.0.1:3000/' })
    expect(result.isError).toBeUndefined()
  })

  it('answers with the page as elements', async () => {
    const { byName } = stub()
    const result = await run(byName.get('browser_open')!, { url: 'https://example.com' })
    expect(result.content).toContain('https://example.com/')
    expect(result.content).toContain('r1   button    "Go"')
  })
})

describe('browser_snapshot', () => {
  it('pages the page text, names the page, and says how to continue', async () => {
    const { byName } = stub()
    const result = await run(byName.get('browser_snapshot')!, { mode: 'text', limit: 100 })
    expect(result.content).toContain('https://example.com/ — "Example"')
    expect(result.content).toContain(`${'a'.repeat(100)}\n… 49900 more character(s); continue with offset=100`)
  })

  it('hands a picture back as an image the loop can keep', async () => {
    const { byName } = stub()
    const result = await run(byName.get('browser_snapshot')!, { mode: 'shot' })
    expect(result.images).toEqual([{ mimeType: 'image/jpeg', data: 'ZmFrZQ==' }])
  })

  it('has no path to write to — that moved to the tool that asks', () => {
    // Asserted on the JSON Schema, which is what the model is actually offered:
    // a `path` on the read-only tool was a way to write without ever being
    // asked, and it must not come back.
    const { byName } = stub()
    const offered = (name: string) => JSON.stringify(z.toJSONSchema(byName.get(name)!.schema))
    expect(offered('browser_snapshot')).not.toContain('"path"')
    expect(offered('browser_screenshot')).toContain('"path"')
  })
})

describe('browser_screenshot', () => {
  it('writes the picture to the path it was given, and says where', async () => {
    // "Open YouTube and save a screenshot" is a request the tools could not
    // answer: the picture went to the chat and there was no way to name a file,
    // so the model went and wrote a CDP script by hand.
    const where = mkdtempSync(path.join(tmpdir(), 'milo-shot-'))
    const { byName } = stub()
    const result = await run(byName.get('browser_screenshot')!, { path: path.join(where, 'youtube.png') })

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('Saved the viewport to')
    expect(result.content).toContain('youtube.png')
    // Saved, not also paid for: an image left in the result rides every request
    // after it, and saving one does not need looking at it.
    expect(result.images).toBeUndefined()
    expect(readFileSync(path.join(where, 'youtube.png'), 'utf8')).toBe('fake')
  })

  it('takes a path and nothing else', () => {
    const { byName } = stub()
    expect(byName.get('browser_screenshot')!.schema.safeParse({}).success).toBe(false)
    expect(byName.get('browser_screenshot')!.schema.safeParse({ path: 'x.png' }).success).toBe(true)
  })

  it('says so when the path cannot be written', async () => {
    const { byName } = stub()
    const result = await run(byName.get('browser_screenshot')!, {
      path: path.join('/nope-does-not-exist', 'x.png'),
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Could not take the screenshot')
  })
})

describe('browser_act', () => {
  it('returns the new page in the same call, which is the point of the feature', async () => {
    const { byName, actions, observed } = stub()
    const result = await run(byName.get('browser_act')!, { action: 'click', ref: 'r1' })
    expect(actions).toEqual([{ action: 'click', ref: 'r1' }])
    expect(observed).toEqual([{ observe: true }])
    expect(result.content).toBe(`did it\n\n${'https://example.com/ — "Example"'}\nh1: Hello\nWords.\n\nr1   button    "Go"`)
  })

  it('skips the look when the caller says it does not need one', async () => {
    const { byName, observed } = stub()
    const result = await run(byName.get('browser_act')!, { action: 'click', ref: 'r1', capture_after: false })
    expect(observed).toEqual([{ observe: false }])
    expect(result.content).toBe('did it')
  })

  it('asks for what is missing instead of guessing', async () => {
    const { byName, actions } = stub()
    const bare = await run(byName.get('browser_act')!, { action: 'click' })
    expect(bare.isError).toBe(true)
    expect(bare.content).toContain("needs a ref")

    const noText = await run(byName.get('browser_act')!, { action: 'type', ref: 'r1' })
    expect(noText.content).toContain('needs the text')

    const noKey = await run(byName.get('browser_act')!, { action: 'press' })
    expect(noKey.content).toContain('needs a key')

    const noPath = await run(byName.get('browser_act')!, { action: 'upload', ref: 'r1' })
    expect(noPath.content).toContain('needs the local file')

    expect(actions).toEqual([])
  })

  it('lets a scroll and a bare key press through without a ref', async () => {
    const { byName, actions } = stub()
    await run(byName.get('browser_act')!, { action: 'scroll', direction: 'down' })
    await run(byName.get('browser_act')!, { action: 'press', key: 'Enter' })
    expect(actions).toEqual([{ action: 'scroll', direction: 'down' }, { action: 'press', key: 'Enter' }])
  })

  it('refuses to fill a password field, and does not act at all', async () => {
    const { byName, actions } = stub({
      elements: { r2: { ref: 'r2', role: 'textbox', name: 'Password', state: '', sensitive: 'password' } },
    })
    const result = await run(byName.get('browser_act')!, { action: 'type', ref: 'r2', text: 'hunter2' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('does not fill credentials')
    expect(actions).toEqual([])
  })

  it('refuses a one-time code and a card field the same way', async () => {
    for (const sensitive of ['credential']) {
      const { byName, actions } = stub({
        elements: { r3: { ref: 'r3', role: 'textbox', name: 'Code', state: '', sensitive } },
      })
      const result = await run(byName.get('browser_act')!, { action: 'type', ref: 'r3', text: '123456' })
      expect(result.isError).toBe(true)
      expect(actions).toEqual([])
    }
  })

  it('still allows clicking around such a field — only filling it is refused', async () => {
    const { byName, actions } = stub({
      elements: { r2: { ref: 'r2', role: 'textbox', name: 'Password', state: '', sensitive: 'password' } },
    })
    const result = await run(byName.get('browser_act')!, { action: 'click', ref: 'r2' })
    expect(result.isError).toBeUndefined()
    expect(actions).toEqual([{ action: 'click', ref: 'r2' }])
  })

  it('resolves an upload path against the working directory, expanding ~', async () => {
    const { byName, actions } = stub()
    await run(byName.get('browser_act')!, { action: 'upload', ref: 'r1', path: 'notes.txt' })
    expect(actions).toEqual([{ action: 'upload', ref: 'r1', path: '/work/notes.txt' }])
  })

  it('reports a refusal from the session as an error, not as a result', async () => {
    const { byName } = stub({ throws: 'r1 is from an earlier look at the page' })
    const result = await run(byName.get('browser_act')!, { action: 'click', ref: 'r1' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('earlier look')
  })
})
