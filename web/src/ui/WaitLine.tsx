import { Icon } from './Icons.js'

/**
 * The wait for something a surface asked for: a steady glyph, the word, and three dots
 * breathing after it, so a screen with nothing to show yet still says it is reading.
 * Whatever arrives next takes this line's place. Drawn by the chat and the mail alike,
 * so a wait looks the same wherever it is.
 */
export function WaitLine({ label }: { label: string }) {
  return <div className="wait-line">
    <Icon name="spark" size={14} />
    <span className="wait-label">{label}</span>
    {/* Motion rather than something to read: out of the accessibility tree. */}
    <span className="wait-dots" aria-hidden="true"><span className="wait-dot" /><span className="wait-dot" /><span className="wait-dot" /></span>
  </div>
}
