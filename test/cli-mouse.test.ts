import { describe, expect, it } from 'vitest'
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
})
