import {
  COLOR_PALETTES,
  COLOR_PALETTE_IDS,
  DEFAULT_COLOR_PALETTE,
  DEFAULT_PALETTE_STATE,
  isColorPaletteId,
  resolveColorPaletteId,
  type ColorPaletteId,
  type ColorPaletteOption,
  type PaletteState,
} from '../../../src/core/color-palettes.js'

export {
  COLOR_PALETTES,
  COLOR_PALETTE_IDS,
  DEFAULT_COLOR_PALETTE,
  DEFAULT_PALETTE_STATE,
  isColorPaletteId,
  resolveColorPaletteId,
  type ColorPaletteId,
  type ColorPaletteOption,
  type PaletteState,
}

export const PALETTE_STORAGE_KEY = 'milo-palette'

export interface PaletteRoleTokens {
  accent: string
  accentOn: string
  accentHover: string
  accentWash: string
}

export interface ColorPalettePreset {
  id: ColorPaletteId
  label: string
  logoColors: readonly [string, string]
  light: PaletteRoleTokens
  dark: PaletteRoleTokens
}

export const COLOR_PALETTE_PRESETS: readonly ColorPalettePreset[] = [
  {
    id: 'terracotta',
    label: 'Terracotta',
    logoColors: ['#A83F1F', '#D66A3A'],
    light: {
      accent: '#A83F1F',
      accentOn: '#FFFFFF',
      accentHover: '#8F3418',
      accentWash: '#F6E8E2',
    },
    dark: {
      accent: '#CC5A32',
      accentOn: '#FFFFFF',
      accentHover: '#D86840',
      accentWash: '#36231C',
    },
  },
  {
    id: 'tangerine',
    label: 'Tangerine',
    logoColors: ['#E94B0C', '#FF9A28'],
    light: {
      accent: '#C8430C',
      accentOn: '#FFFFFF',
      accentHover: '#AC3808',
      accentWash: '#F9EAE2',
    },
    dark: {
      accent: '#DF5B20',
      accentOn: '#FFFFFF',
      accentHover: '#EA6B32',
      accentWash: '#3A241A',
    },
  },
  {
    id: 'apricot',
    label: 'Apricot',
    logoColors: ['#D96B36', '#E9AF56'],
    light: {
      accent: '#BD5828',
      accentOn: '#FFFFFF',
      accentHover: '#A1491E',
      accentWash: '#F8ECE4',
    },
    dark: {
      accent: '#D46D3A',
      accentOn: '#FFFFFF',
      accentHover: '#DF7C4B',
      accentWash: '#38271E',
    },
  },
  {
    id: 'peach',
    label: 'Peach',
    logoColors: ['#D96D5A', '#F3B18F'],
    light: {
      accent: '#C25947',
      accentOn: '#FFFFFF',
      accentHover: '#A84A3A',
      accentWash: '#F8EAE7',
    },
    dark: {
      accent: '#D66B58',
      accentOn: '#FFFFFF',
      accentHover: '#E07A68',
      accentWash: '#382522',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    logoColors: ['#315C3B', '#73A66A'],
    light: {
      accent: '#315C3B',
      accentOn: '#FFFFFF',
      accentHover: '#264A2F',
      accentWash: '#E6EFE8',
    },
    dark: {
      accent: '#4B8354',
      accentOn: '#FFFFFF',
      accentHover: '#589262',
      accentWash: '#1E2E21',
    },
  },
  {
    id: 'mint',
    label: 'Mint',
    logoColors: ['#3D9B83', '#83CBB0'],
    light: {
      accent: '#2B7A65',
      accentOn: '#FFFFFF',
      accentHover: '#216351',
      accentWash: '#E4F2EE',
    },
    dark: {
      accent: '#3B947C',
      accentOn: '#FFFFFF',
      accentHover: '#48A38A',
      accentWash: '#1B312B',
    },
  },
  {
    id: 'lime',
    label: 'Lime',
    logoColors: ['#799B22', '#C0D64F'],
    light: {
      accent: '#5E7A18',
      accentOn: '#FFFFFF',
      accentHover: '#4C6411',
      accentWash: '#EDF2E1',
    },
    dark: {
      accent: '#759624',
      accentOn: '#FFFFFF',
      accentHover: '#84A630',
      accentWash: '#273019',
    },
  },
  {
    id: 'cherry',
    label: 'Cherry',
    logoColors: ['#C5294C', '#F07551'],
    light: {
      accent: '#BD284A',
      accentOn: '#FFFFFF',
      accentHover: '#A11F3D',
      accentWash: '#F8E5EA',
    },
    dark: {
      accent: '#D44260',
      accentOn: '#FFFFFF',
      accentHover: '#DF5370',
      accentWash: '#381E24',
    },
  },
  {
    id: 'rose',
    label: 'Rose',
    logoColors: ['#B84F72', '#E9949C'],
    light: {
      accent: '#AE476A',
      accentOn: '#FFFFFF',
      accentHover: '#943A59',
      accentWash: '#F6E7EC',
    },
    dark: {
      accent: '#C96082',
      accentOn: '#FFFFFF',
      accentHover: '#D47191',
      accentWash: '#352229',
    },
  },
  {
    id: 'ocean',
    label: 'Ocean',
    logoColors: ['#318EA8', '#58B8A0'],
    light: {
      accent: '#27748B',
      accentOn: '#FFFFFF',
      accentHover: '#1E5E72',
      accentWash: '#E4EFF3',
    },
    dark: {
      accent: '#388EA6',
      accentOn: '#FFFFFF',
      accentHover: '#469DB5',
      accentWash: '#1B2D33',
    },
  },
  {
    id: 'lagoon',
    label: 'Lagoon',
    logoColors: ['#3479C4', '#54C6C0'],
    light: {
      accent: '#2B68AD',
      accentOn: '#FFFFFF',
      accentHover: '#21548F',
      accentWash: '#E5EEF8',
    },
    dark: {
      accent: '#4282C8',
      accentOn: '#FFFFFF',
      accentHover: '#5291D4',
      accentWash: '#1D2A38',
    },
  },
  {
    id: 'berry',
    label: 'Berry',
    logoColors: ['#8F59B8', '#D85D85'],
    light: {
      accent: '#814CA8',
      accentOn: '#FFFFFF',
      accentHover: '#6C3D8F',
      accentWash: '#F0E8F6',
    },
    dark: {
      accent: '#9B65C2',
      accentOn: '#FFFFFF',
      accentHover: '#A875CD',
      accentWash: '#2D2236',
    },
  },
  {
    id: 'violet',
    label: 'Violet',
    logoColors: ['#6357B8', '#C16BC4'],
    light: {
      accent: '#5A4EAD',
      accentOn: '#FFFFFF',
      accentHover: '#493E92',
      accentWash: '#EAE8F7',
    },
    dark: {
      accent: '#7668C9',
      accentOn: '#FFFFFF',
      accentHover: '#8578D4',
      accentWash: '#252238',
    },
  },
] as const

const PRESET_BY_ID = new Map<ColorPaletteId, ColorPalettePreset>(
  COLOR_PALETTE_PRESETS.map((preset) => [preset.id, preset]),
)

export function colorPalettePreset(id: unknown): ColorPalettePreset {
  const resolved = resolveColorPaletteId(id)
  return PRESET_BY_ID.get(resolved) ?? PRESET_BY_ID.get(DEFAULT_COLOR_PALETTE)!
}

export function effectivePaletteId(local: ColorPaletteId, shared: PaletteState): ColorPaletteId {
  return shared.sync ? resolveColorPaletteId(shared.palette) : resolveColorPaletteId(local)
}

export function readStoredPalette(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null,
): ColorPaletteId {
  try {
    return resolveColorPaletteId(storage?.getItem(PALETTE_STORAGE_KEY))
  } catch {
    return DEFAULT_COLOR_PALETTE
  }
}

export function writeStoredPalette(
  id: ColorPaletteId,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage !== 'undefined' ? localStorage : null,
): void {
  try {
    storage?.setItem(PALETTE_STORAGE_KEY, resolveColorPaletteId(id))
  } catch {
    // Ignore storage errors in restricted browser contexts.
  }
}

export interface PaletteTargetElement {
  dataset: Record<string, string | undefined>
  style: {
    setProperty(name: string, value: string): void
  }
}

export function applyColorPalette(
  id: unknown,
  root: PaletteTargetElement | null | undefined = (
    globalThis as { document?: { documentElement?: PaletteTargetElement } }
  ).document?.documentElement ?? null,
): ColorPalettePreset {
  const preset = colorPalettePreset(id)
  if (root) {
    root.dataset.palette = preset.id
    root.style.setProperty('--palette-light-accent', preset.light.accent)
    root.style.setProperty('--palette-light-accent-on', preset.light.accentOn)
    root.style.setProperty('--palette-light-accent-hover', preset.light.accentHover)
    root.style.setProperty('--palette-light-accent-wash', preset.light.accentWash)
    root.style.setProperty('--palette-dark-accent', preset.dark.accent)
    root.style.setProperty('--palette-dark-accent-on', preset.dark.accentOn)
    root.style.setProperty('--palette-dark-accent-hover', preset.dark.accentHover)
    root.style.setProperty('--palette-dark-accent-wash', preset.dark.accentWash)
    root.style.setProperty('--milo-mark-top', preset.logoColors[0])
    root.style.setProperty('--milo-mark-bottom', preset.logoColors[1])
  }
  return preset
}
