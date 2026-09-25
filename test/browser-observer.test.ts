import { describe, expect, it } from 'vitest'
import {
  formatElement,
  formatSnapshot,
  mergeObservations,
  observeExpression,
  refExpression,
  type FrameObservation,
  type Observation,
} from '../src/core/browser/observer.js'

const element = (ref: string, role: string, name: string, state = '', sensitive: string | null = null) => ({
  ref,
  role,
  name,
  state,
  sensitive,
})

const frame = (over: Partial<FrameObservation> = {}): FrameObservation => ({
  url: 'https://example.com/',
  title: 'Example',
  heading: 'Hello',
  text: 'Some words about the page.',
  textTruncated: false,
  frame: 'main',
  elements: [element('r1', 'link', 'More')],
  more: false,
  ...over,
})

describe('formatElement', () => {
  it('reads as ref, role, name, state', () => {
    expect(formatElement(element('r7', 'button', 'Sign in', 'disabled'))).toBe(
      'r7   button    "Sign in"  [disabled]',
    )
  })

  it('says nothing about a state an element does not have', () => {
    expect(formatElement(element('r1', 'link', 'Home'))).toBe('r1   link      "Home"')
  })

  it('marks a field Milo will not fill, where the model can see it', () => {
    expect(formatElement(element('r9', 'textbox', 'Password', '', 'password'))).toContain(
      '<password field — Milo does not fill this>',
    )
  })

  it('keeps the columns aligned across different role lengths', () => {
    const lines = [
      formatElement(element('r1', 'link', 'A')),
      formatElement(element('r2', 'checkbox', 'B')),
    ]
    expect(lines[0]!.indexOf('"A"')).toBe(lines[1]!.indexOf('"B"'))
  })
})

describe('formatSnapshot', () => {
  it('leads with where the page is, then the elements', () => {
    const text = formatSnapshot(mergeObservations([frame()]))
    const lines = text.split('\n')
    expect(lines[0]).toBe('https://example.com/ — "Example"')
    expect(lines[1]).toBe('h1: Hello')
    expect(lines).toContain('r1   link      "More"')
  })

  it('says so when there is nothing to act on', () => {
    expect(formatSnapshot(mergeObservations([frame({ elements: [] })]))).toContain(
      '(no interactive elements on this page)',
    )
  })

  it('says when the list was cut, so a missing element is not read as absent', () => {
    const text = formatSnapshot(mergeObservations([frame({ more: true })]))
    expect(text).toContain('only the first 1 elements are shown')
  })

  it('names a frame it could not read, rather than going quiet about it', () => {
    const text = formatSnapshot(mergeObservations([frame()], ['frame 2: script error']))
    expect(text).toContain('(could not read: frame 2: script error)')
  })

  it('marks text that was cut for length', () => {
    const text = formatSnapshot(mergeObservations([frame({ text: 'a'.repeat(400), textTruncated: true })]))
    expect(text).toContain(`${'a'.repeat(400)}…`)
  })
})

describe('mergeObservations', () => {
  it('stitches the frames into one list, in order', () => {
    const merged = mergeObservations([
      frame({ elements: [element('r1', 'link', 'One')] }),
      frame({ frame: 'frame 2', elements: [element('r2', 'button', 'Two')], heading: '' }),
    ])
    expect(merged.elements.map((entry) => entry.ref)).toEqual(['r1', 'r2'])
    // The first frame owns the page's identity; a later one has no say.
    expect(merged.url).toBe('https://example.com/')
    expect(merged.heading).toBe('Hello')
  })

  it('carries "more" up from any frame, not just the first', () => {
    const merged = mergeObservations([frame(), frame({ frame: 'frame 2', more: true })])
    expect(merged.more).toBe(true)
  })

  it('survives a page with no frames at all', () => {
    const merged = mergeObservations([])
    expect(merged).toMatchObject<Partial<Observation>>({ url: '', title: '', elements: [] })
  })
})

describe('the expressions sent to the page', () => {
  it('passes the frame, the starting ref number and the observation it belongs to', () => {
    const expression = observeExpression('main', 20, 'nonce-1')
    expect(expression).toContain('"main"')
    expect(expression).toContain(', 20, ')
    expect(expression).toContain('"nonce-1"')
  })

  it('looks a ref up under the observation that minted it', () => {
    expect(refExpression('nonce-1', 'r7')).toBe('globalThis.__miloRefs["nonce-1:r7"]')
  })

  it('quotes the nonce, so a ref cannot be read as anything but a key', () => {
    expect(refExpression('a"b', 'r1')).toBe('globalThis.__miloRefs["a\\"b:r1"]')
  })
})
