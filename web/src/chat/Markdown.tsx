import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { memo, useMemo } from 'react'

marked.setOptions({ breaks: true, gfm: true })

/**
 * The answer as it renders in the browser. Parsed from Markdown and sanitized
 * before it reaches the DOM, so no script or event handler from a model reply
 * survives — and memoized per text, because a streaming turn re-renders the
 * whole thread on every token and re-parsing every earlier message each time
 * is quadratic work for a screen that is only growing at the end.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text) as string, { USE_PROFILES: { html: true } }),
    [text],
  )
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the HTML is produced by marked and sanitized with DOMPurify above, which strips scripts, event handlers and unsafe URLs.
  return <div className="message-prose" dangerouslySetInnerHTML={{ __html: html }} />
})
