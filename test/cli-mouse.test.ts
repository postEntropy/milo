import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyToClipboard,
  enterBracketedPaste,
  enterMouseTracking,
  exitTui,
  setMouseTracking,
} from '../src/gateways/cli/ansi.js'
import { translateWheel } from '../src/gateways/cli/mouse.js'

const wheelUp = '\u001b[<64;52;32M'
const wheelDown = '\u001b[<65;52;32M'

describe('reading the mouse that comes off the terminal', () => {
  it('turns the wheel into alt+arrow, which is what scrolls the transcript', () => {
    expect(translateWheel(wheelUp).text).toBe('\u001b[1;3A')
    expect(translateWheel(wheelDown).text).toBe('\u001b[1;3B')
  })

  it('lets everything that is not the mouse through, keys included', () => {
    expect(translateWheel('abc\u001b[A').text).toBe('abc\u001b[A')
  })

  it('swallows clicks and drags, which have nothing to do here', () => {
    expect(translateWheel('\u001b[<0;10;5M\u001b[<0;10;5m').text).toBe('')
    expect(translateWheel('a\u001b[<32;10;5M\u001b[<35;12;6Mb').text).toBe('ab')
  })

  it('counts the modifiers along with the button', () => {
    // 68 is the wheel up with shift (4) added to the button code.
    expect(translateWheel('\u001b[<68;1;1M').text).toBe('\u001b[1;3A')
  })

  it('holds an event cut in half and finishes it on the next piece', () => {
    const first = translateWheel('\u001b[<64;52')
    expect(first.text).toBe('')
    expect(first.carry).toBe('\u001b[<64;52')

    const second = translateWheel(';32M', first.carry)
    expect(second.text).toBe('\u001b[1;3A')
    expect(second.carry).toBe('')
  })

  it('does not hold a lone escape, which is the Escape key', () => {
    expect(translateWheel('\u001b').text).toBe('\u001b')
    expect(translateWheel('\u001b').carry).toBe('')
  })

  it('turns a whole drag into one step per tick', () => {
    const drag = `${wheelDown}${wheelDown}${wheelDown}`
    expect(translateWheel(drag).text).toBe('\u001b[1;3B\u001b[1;3B\u001b[1;3B')
  })

  it('passes bracketed paste sequences and pasted text through intact', () => {
    const pasted = '\u001b[200~line 1\nline 2; [ok] <tag>\u001b[201~'
    expect(translateWheel(pasted)).toEqual({ text: pasted, carry: '' })
  })

  it('keeps bracketed paste intact when split across chunks alongside SGR mouse events', () => {
    const c1 = translateWheel(`${wheelUp}\u001b[20`)
    expect(c1).toEqual({ text: '\u001b[1;3A\u001b[20', carry: '' })

    const c2 = translateWheel('0~hello\nworld\u001b[201~\u001b[<65;10', c1.carry)
    expect(c2).toEqual({ text: '0~hello\nworld\u001b[201~', carry: '\u001b[<65;10' })

    const c3 = translateWheel(';20M\u001b[<0;1;1m', c2.carry)
    expect(c3).toEqual({ text: '\u001b[1;3B', carry: '' })

    expect(c1.text + c2.text + c3.text).toBe(
      '\u001b[1;3A\u001b[200~hello\nworld\u001b[201~\u001b[1;3B',
    )
  })
})

describe('terminal ANSI modes and clipboard', () => {
  afterEach(() => {
    exitTui()
    vi.restoreAllMocks()
  })

  it('writes UTF-8 base64 OSC 52 sequences to stdout when copying to clipboard', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    copyToClipboard('hello')
    expect(write).toHaveBeenLastCalledWith('\u001b]52;c;aGVsbG8=\u0007')
    copyToClipboard('hi 🌍')
    expect(write).toHaveBeenLastCalledWith(
      `\u001b]52;c;${Buffer.from('hi 🌍', 'utf8').toString('base64')}\u0007`,
    )
    copyToClipboard('copied text')
    expect(write).toHaveBeenLastCalledWith(
      `\u001b]52;c;${Buffer.from('copied text', 'utf8').toString('base64')}\u0007`,
    )
  })

  it('toggles mouse tracking idempotently', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    enterMouseTracking()
    expect(write).toHaveBeenLastCalledWith('\u001b[?1000h\u001b[?1006h')

    setMouseTracking(true)
    expect(write).toHaveBeenCalledTimes(1)

    setMouseTracking(false)
    expect(write).toHaveBeenLastCalledWith('\u001b[?1000l\u001b[?1006l')

    setMouseTracking(false)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('enables bracketed paste idempotently and restores it on exitTui', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    enterBracketedPaste()
    enterBracketedPaste()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenLastCalledWith('\u001b[?2004h')

    exitTui()
    exitTui()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith('\u001b[?2004l')
  })
})
