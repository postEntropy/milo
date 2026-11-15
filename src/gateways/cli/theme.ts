import {
  isColorPaletteId,
  resolveColorPaletteId,
  type ColorPaletteId,
} from '../../core/color-palettes.js'

/**
 * Milo's palette. `accent` marks the active voice and current focus; the rest
 * are semantic states and supporting text roles.
 *
 * Text colors are chosen for contrast, not for looks alone. Each one clears 4.4:1
 * against a light background (flexoki-light, `#FFFCF0`) *and* 4:1 against a dark
 * one (`#100F0F`) — the best a single tone can do, since the most a colour can
 * reach against both is about 4.3:1, and anything prettier is only prettier on
 * the one background it was designed against.
 *
 * Naming an ANSI colour does not save you from this: a theme may map `gray`
 * (bright black) to something 2:1 from its own background, which is precisely
 * what the faded `gray` and `dimColor` text here did. Ink accepts named colours,
 * `#hex`, `rgb(…)` and `ansi256(…)` — but a value that carries meaning should be
 * a value this file chose.
 *
 * `surface` is the fill of a filled control — the composer — rather than a text
 * colour, so the rule above is read a little differently: it is a mid tone, where
 * the terminal's own foreground clears 4:1 whether that foreground is dark or
 * light. A filled control cannot assume the terminal's background, and the typed
 * text is drawn in the terminal's own foreground (Ink's text input takes no
 * colour), so a fill that is not mid would make the text vanish on one theme or
 * the other. It is a quiet neutral, not a colour of its own: the composer is
 * delimited by its fill, while the colour on the screen belongs to the text
 * written in it and beside it. `surfaceText` is for what is written *on* the fill
 * when it cannot borrow the terminal's foreground — the placeholder, whose grey
 * would disappear against a mid tone.
 */
export interface TuiTheme {
  accent: string
  secondary: string
  success: string
  warning: string
  danger: string
  muted: string
  surface: string
  surfaceText: string
  logoTop: string
  logoBottom: string
}

export const theme = {
  accent: '#C4541C',
  secondary: '#508080',
  success: '#587E20',
  warning: '#976C0C',
  danger: '#DA392F',
  muted: '#7D7373',
  surface: '#7C7568',
  surfaceText: '#E8E3D8',
  logoTop: '#C4541C',
  logoBottom: '#B95C32',
} as const satisfies TuiTheme

export type ThemeColor = TuiTheme[keyof TuiTheme]

/**
 * Single-tone terminal accents for every shared palette ID, tuned so each
 * clears 4.4:1 against `#FFFCF0` and 4.0:1 against `#100F0F`.
 */
const PALETTE_ACCENTS: Record<ColorPaletteId, string> = {
  terracotta: '#C5522B',
  tangerine: '#CE4B13',
  apricot: '#BE5828',
  peach: '#C15441',
  forest: '#488352',
  mint: '#2D846D',
  lime: '#638019',
  cherry: '#D73A5A',
  rose: '#BF5074',
  ocean: '#2E7F98',
  lagoon: '#3778C1',
  berry: '#975CC2',
  violet: '#7668C9',
}

/**
 * Two-tone logo mark pairs for every shared palette ID, matching the web's
 * `logoColors` tuned so both tones clear 4.4:1 against `#FFFCF0` and 4.0:1
 * against `#100F0F`.
 */
const PALETTE_LOGO_COLORS: Record<ColorPaletteId, readonly [string, string]> = {
  terracotta: ['#C64A25', '#B95C32'],
  tangerine: ['#D4440B', '#AA661B'],
  apricot: ['#BA5B2E', '#946F37'],
  peach: ['#B65C4C', '#956D58'],
  forest: ['#447F51', '#598052'],
  mint: ['#34836F', '#527F6E'],
  lime: ['#637F1C', '#6F7C2E'],
  cherry: ['#D72D53', '#B95A3E'],
  rose: ['#B84F72', '#A1666C'],
  ocean: ['#2C8097', '#3E8271'],
  lagoon: ['#3478C3', '#37817D'],
  berry: ['#925BBC', '#BD5174'],
  violet: ['#7063D1', '#A45BA7'],
}

/** Resolves a palette ID to a TUI theme, defaulting to the base `theme` when unset. */
export function resolveTuiTheme(paletteId?: ColorPaletteId): TuiTheme {
  if (!paletteId) return theme
  const resolved = isColorPaletteId(paletteId) ? paletteId : resolveColorPaletteId(paletteId)
  const [logoTop, logoBottom] = PALETTE_LOGO_COLORS[resolved]
  return { ...theme, accent: PALETTE_ACCENTS[resolved], logoTop, logoBottom }
}
