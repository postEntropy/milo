/**
 * The accent palettes Web and iOS Settings offer.
 *
 * Each surface renders its own light/dark accent tokens and translucent mark
 * gradients from these stable IDs, while the daemon stores only the shared
 * selection and whether sync is on.
 */
export const COLOR_PALETTES = [
  { id: 'terracotta', label: 'Terracotta' },
  { id: 'tangerine', label: 'Tangerine' },
  { id: 'apricot', label: 'Apricot' },
  { id: 'peach', label: 'Peach' },
  { id: 'forest', label: 'Forest' },
  { id: 'mint', label: 'Mint' },
  { id: 'lime', label: 'Lime' },
  { id: 'cherry', label: 'Cherry' },
  { id: 'rose', label: 'Rose' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'lagoon', label: 'Lagoon' },
  { id: 'berry', label: 'Berry' },
  { id: 'violet', label: 'Violet' },
] as const

export const COLOR_PALETTE_IDS = [
  'terracotta',
  'tangerine',
  'apricot',
  'peach',
  'forest',
  'mint',
  'lime',
  'cherry',
  'rose',
  'ocean',
  'lagoon',
  'berry',
  'violet',
] as const

export type ColorPaletteId = (typeof COLOR_PALETTE_IDS)[number]

export interface ColorPaletteOption {
  id: ColorPaletteId
  label: string
}

export const DEFAULT_COLOR_PALETTE: ColorPaletteId = 'peach'

export interface PaletteState {
  sync: boolean
  palette: ColorPaletteId
}

export const DEFAULT_PALETTE_STATE: PaletteState = {
  sync: false,
  palette: DEFAULT_COLOR_PALETTE,
}

const KNOWN = new Set<string>(COLOR_PALETTE_IDS)

export function isColorPaletteId(value: unknown): value is ColorPaletteId {
  return typeof value === 'string' && KNOWN.has(value)
}

/** Resolves missing or unknown local palette IDs to the Peach default. */
export function resolveColorPaletteId(value: unknown): ColorPaletteId {
  return isColorPaletteId(value) ? value : DEFAULT_COLOR_PALETTE
}

export function colorPaletteNames(): string {
  return COLOR_PALETTE_IDS.join(', ')
}
