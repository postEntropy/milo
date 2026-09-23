import { describe, expect, it } from 'vitest'
import { htmlToText } from '../src/core/tools/html.js'

describe('htmlToText', () => {
  it('keeps the text and drops the tags', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world')
  })

  it('drops scripts, styles and comments', () => {
    const html = '<style>p{color:red}</style><p>kept</p><script>alert(1)</script><!-- note -->'
    expect(htmlToText(html)).toBe('kept')
  })

  it('keeps the block structure as line breaks', () => {
    expect(htmlToText('<h1>Title</h1><p>one</p><p>two</p>')).toBe('Title\none\ntwo')
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc')
  })

  it('does not break a word that merely starts like a tag', () => {
    expect(htmlToText('<li>item</li><link rel="stylesheet" href="a.css">')).toBe('item')
  })

  it('decodes named and numeric entities', () => {
    expect(htmlToText('Tom &amp; Jerry &lt;3 &#39;quoted&#39; &#x27;x&#x27; &nbsp;end')).toBe(
      "Tom & Jerry <3 'quoted' 'x' end",
    )
  })

  it('leaves an entity it does not know alone', () => {
    expect(htmlToText('&weird; &#zero;')).toBe('&weird; &#zero;')
  })

  it('collapses the whitespace the source was formatted with', () => {
    expect(htmlToText('<div>\n   spaced\n\n      out\n</div>')).toBe('spaced out')
  })
})
