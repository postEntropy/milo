import { Box, Text } from 'ink'
import { theme as defaultTheme, type TuiTheme } from '../theme.js'

export interface MiloMarkProps {
  theme?: TuiTheme & { logoTop?: string; logoBottom?: string }
  compact?: boolean
}

export interface MiloMarkSegment {
  id: string
  text: string
  color?: string
}

export interface MiloMarkRow {
  id: string
  text: string
  color: string
  segments: MiloMarkSegment[]
}

const REF_TOP: readonly [number, number, number] = [217, 109, 90]
const REF_BOTTOM: readonly [number, number, number] = [243, 177, 143]

/**
 * Minimalist 3-row (8×3) half-block reduction of the Milo SVG mark:
 * top petal (`#d96d5a`), gradient overlap band (`#efa787`..`#e79378`), and bottom petal (`#f3b18f`).
 */
const RAW_MARK_ROWS: ReadonlyArray<ReadonlyArray<{ text: string; color?: string }>> = [
  [
    { text: ' ' },
    { text: '▄▄████', color: '#d96d5a' },
    { text: '█', color: '#cf6855' },
    { text: '▄', color: '#da6d5a' },
  ],
  [
    { text: '▄█', color: '#f3b18f' },
    { text: '█', color: '#efa787' },
    { text: '█', color: '#eda182' },
    { text: '█', color: '#ec9d81' },
    { text: '█', color: '#eb9b7d' },
    { text: '█', color: '#e79378' },
    { text: '▀', color: '#da6d5a' },
  ],
  [
    { text: '▀█████▀', color: '#f3b18f' },
    { text: ' ' },
  ],
]

function parseHexRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null
  const num = Number.parseInt(clean, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

function tintMarkColor(
  sampleHex: string,
  topRgb: [number, number, number] | null,
  bottomRgb: [number, number, number] | null,
): string {
  if (!topRgb || !bottomRgb) return sampleHex
  const rgb = parseHexRgb(sampleHex)
  if (!rgb) return sampleHex
  const [r, g] = rgb
  const ratio = r > 0 ? g / r : 0.5023
  const t = Math.max(0, Math.min(1, (ratio - 0.5023) / (0.7284 - 0.5023)))
  const refR = (1 - t) * REF_TOP[0] + t * REF_BOTTOM[0]
  const shade = Math.max(0, Math.min(1.05, r / refR))
  const channels = [0, 1, 2].map((idx) =>
    Math.round(Math.max(0, Math.min(255, ((1 - t) * topRgb[idx]! + t * bottomRgb[idx]!) * shade))),
  )
  return `#${channels.map((ch) => ch.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Minimalist 3-row half-block Milo mark with overlap gradient, shared by
 * `<MiloMark>` and the chat empty-state hero.
 */
export function miloMarkRows(
  activeTheme: TuiTheme & { logoTop?: string; logoBottom?: string } = defaultTheme,
): readonly [MiloMarkRow, MiloMarkRow, MiloMarkRow] {
  const topColor = activeTheme.logoTop ?? activeTheme.accent
  const bottomColor = activeTheme.logoBottom ?? activeTheme.secondary
  const isDefaultTheme =
    topColor === defaultTheme.logoTop && bottomColor === defaultTheme.logoBottom
  const topRgb = isDefaultTheme ? null : parseHexRgb(topColor)
  const bottomRgb = isDefaultTheme ? null : parseHexRgb(bottomColor)

  const built = RAW_MARK_ROWS.map((rawSegments, rowIndex) => {
    const segments: MiloMarkSegment[] = rawSegments.map((seg, segIndex) => ({
      id: `r${rowIndex}-s${segIndex}`,
      text: seg.text,
      ...(seg.color ? { color: tintMarkColor(seg.color, topRgb, bottomRgb) } : {}),
    }))
    return {
      id: `mark-row-${rowIndex}`,
      text: segments.map((s) => s.text).join(''),
      color: rowIndex === 0 ? topColor : bottomColor,
      segments,
    }
  })

  return [built[0]!, built[1]!, built[2]!]
}

/** Minimalist 3-row Milo mark for the CLI hero and 1-line compact header badge. */
export function MiloMark({ theme: activeTheme = defaultTheme, compact = false }: MiloMarkProps) {
  const topColor = activeTheme.logoTop ?? activeTheme.accent
  const bottomColor = activeTheme.logoBottom ?? activeTheme.secondary

  if (compact) {
    return (
      <Text>
        <Text color={topColor}>▀</Text>
        <Text color={bottomColor}>▄</Text>
        <Text bold color={topColor}>
          {' MILO'}
        </Text>
      </Text>
    )
  }

  const rows = miloMarkRows(activeTheme)
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Text key={row.id}>
          {row.segments.map((segment) =>
            segment.color ? (
              <Text key={segment.id} color={segment.color}>
                {segment.text}
              </Text>
            ) : (
              segment.text
            ),
          )}
        </Text>
      ))}
    </Box>
  )
}
