/**
 * Milo's palette. `accent` is the primary colour (the prompt, the composer
 * border); the rest are semantic states.
 *
 * The values are chosen for contrast, not for looks alone. Each one clears 4.4:1
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
 */
export const theme = {
  accent: '#C4541C',
  success: '#587E20',
  warning: '#976C0C',
  danger: '#DA392F',
  muted: '#7D7373',
} as const

export type ThemeColor = (typeof theme)[keyof typeof theme]
