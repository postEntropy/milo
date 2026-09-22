/**
 * Milo's palette. `accent` is the primary colour (orange); the rest are
 * semantic states. Ink accepts named colours, `#hex`, `rgb(…)` and `ansi256(…)`,
 * so change `accent` to restyle the whole CLI.
 */
export const theme = {
  accent: '#ff9e64',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  muted: 'gray',
} as const

export type ThemeColor = (typeof theme)[keyof typeof theme]
