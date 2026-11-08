import { useId } from 'react'
import { colorPalettePreset, type ColorPaletteId } from '../theme/palettes.js'

export const MILO_MARK_TOP_PATH =
  'M24.3043 6.36162C30.164 6.35984 34.9311 11.0477 34.9329 16.8512C34.9347 22.6548 30.1704 27.3455 24.3107 27.3473C20.948 27.3483 18.3243 26.0127 16.0437 23.4493C14.5743 21.7978 11.3686 18.8459 9.47251 17.6118C9.21316 17.443 9.05882 17.1536 9.06354 16.8449C9.06838 16.5364 9.23157 16.2518 9.49587 16.091C11.4042 14.9307 14.557 11.9332 16.0397 10.2646C18.3187 7.69982 20.9416 6.36264 24.3043 6.36162Z'

export const MILO_MARK_BOTTOM_PATH =
  'M19.758 17.2788C13.8984 17.2424 9.10353 21.9021 9.06729 27.7055C9.03105 33.509 13.7674 38.2277 19.627 38.264C22.9896 38.2849 25.6212 36.9648 27.9169 34.4149C29.3961 32.7721 32.6193 29.8392 34.5227 28.6163C34.7831 28.449 34.9391 28.1605 34.9362 27.8518C34.9332 27.5432 34.7717 27.2577 34.5084 27.0953C32.607 25.9238 29.4721 22.9077 27.9993 21.2304C25.7356 18.6523 23.1206 17.2996 19.758 17.2788Z'

export function MiloMark({
  palette,
  size = 18,
  className = '',
  title,
}: {
  palette?: ColorPaletteId
  size?: number
  className?: string
  title?: string
}) {
  const uid = useId().replace(/:/g, '')
  const topId = `milo-mark-top-${uid}`
  const bottomId = `milo-mark-bottom-${uid}`
  const preset = palette ? colorPalettePreset(palette) : null
  const topColor = preset ? preset.logoColors[0] : 'var(--milo-mark-top, #D96D5A)'
  const bottomColor = preset ? preset.logoColors[1] : 'var(--milo-mark-bottom, #F3B18F)'

  return (
    <svg
      className={className || undefined}
      width={size}
      height={size}
      viewBox="6 6.31 32 32"
      fill="none"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path d={MILO_MARK_TOP_PATH} fill={`url(#${topId})`} />
      <path d={MILO_MARK_BOTTOM_PATH} fill={`url(#${bottomId})`} />
      <defs>
        <linearGradient id={topId} x1="34.9329" y1="16.8512" x2="9.06343" y2="16.8591" gradientUnits="userSpaceOnUse">
          <stop stopColor={topColor} stopOpacity="0.8" />
          <stop offset="1" stopColor={topColor} stopOpacity="0.5" />
        </linearGradient>
        <linearGradient id={bottomId} x1="9.06729" y1="27.7055" x2="34.9362" y2="27.867" gradientUnits="userSpaceOnUse">
          <stop stopColor={bottomColor} stopOpacity="0.8" />
          <stop offset="1" stopColor={bottomColor} stopOpacity="0.5" />
        </linearGradient>
      </defs>
    </svg>
  )
}
