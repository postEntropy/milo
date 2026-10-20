import DOMPurify from 'dompurify'
import { marked, type Tokens } from 'marked'
import { memo, useMemo } from 'react'
import { codeHtml } from '../ui/Code.js'

marked.setOptions({ breaks: true, gfm: true })

/**
 * A fenced block is coloured as it is parsed, out of the runs the core lexer reads from it —
 * the phone colours the same fence with that lexer's Swift port. The fence's tag names the
 * language and is not drawn or kept: on this surface it was only ever the highlighter's own
 * input, and by the time the block is drawn the reading has happened.
 */
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      // A fence with nothing in it is dropped below rather than drawn as an empty box, and it
      // is handed over in the same shape so that rule keeps holding.
      if (text.trim() === '') return '<pre><code></code></pre>\n'
      return `<pre><code>${codeHtml(text, lang?.trim().split(/\s+/)[0])}</code></pre>\n`
    },
  },
})

/**
 * The answer as it renders in the browser. Parsed from Markdown and sanitized
 * before it reaches the DOM, so no script or event handler from a model reply
 * survives — and memoized per text, because a streaming turn re-renders the
 * whole thread on every token and re-parsing every earlier message each time
 * is quadratic work for a screen that is only growing at the end.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    // A link in an answer leads away from the conversation, so it opens in its own
    // tab instead of navigating the app out from under itself. Added and taken back
    // around this one call, as the mail body's own hardening is.
    const away = (node: Element): void => {
      const href = node.tagName === 'A' ? node.getAttribute('href') : null
      if (href === null || href.startsWith('#')) return
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noreferrer noopener')
    }
    DOMPurify.addHook('afterSanitizeAttributes', away)
    let clean: string
    try {
      clean = DOMPurify.sanitize(marked.parse(text) as string, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ['target', 'rel'],
      })
    } finally {
      DOMPurify.removeHook('afterSanitizeAttributes', away)
    }
    // A fence the model closes with nothing inside it would draw as an empty box, since
    // the block carries its own padding — drop it instead of painting the gap.
    return clean.replace(/<pre><code[^>]*>\s*<\/code><\/pre>/g, '')
  }, [text])
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the HTML is produced by marked and sanitized with DOMPurify above, which strips scripts, event handlers and unsafe URLs.
  return <div className="message-prose" dangerouslySetInnerHTML={{ __html: html }} />
})
