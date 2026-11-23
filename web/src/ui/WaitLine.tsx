import { Icon, type IconName } from './Icons.js'

/**
 * The wait for something a surface asked for: a steady glyph and the word, with the
 * glare travelling along it, so a screen with nothing to show yet still says it is
 * reading. Whatever arrives next takes this line's place. Drawn by the chat and the
 * mail alike, so a wait looks the same wherever it is.
 */
export function WaitLine({ label, icon = 'spark' }: { label: string; icon?: IconName }) {
  return <div className="wait-line">
    <Icon name={icon} size={14} />
    <span className="glare">{label}</span>
  </div>
}
