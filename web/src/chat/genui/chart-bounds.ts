/** The range a chart is drawn on: always including zero, and rounded out. */
export interface ChartBounds {
  min: number
  max: number
}

/**
 * The range a chart is drawn on, so the marks stand at the height the numbers say.
 *
 * A bar chart starts at zero (`zero` is true): a bar that does not is a difference
 * exaggerated by its own picture. A line or a sparkline is the shape that matters, so
 * it takes the series' own range with an eighth of it as air on either side — a run
 * rate of $380k–$455k read on a zero-based axis is a flat line at the top, which is
 * the one thing the chart was drawn to avoid.
 *
 * The phone draws the same range with the same rule (`MiloGenUi.chartBounds`); the
 * two are held together by the cases on disk.
 */
export function chartBounds(series: number[][], zero = true): ChartBounds {
  const values = series.flat().filter((value) => Number.isFinite(value))
  if (values.length === 0) return { min: 0, max: 1 }
  const low = Math.min(...values)
  const high = Math.max(...values)
  if (!zero) {
    const span = high - low
    const pad = span === 0 ? (Math.abs(high) > 0 ? Math.abs(high) * 0.1 : 1) : span * 0.08
    return { min: low - pad, max: high + pad }
  }
  const max = high > 0 ? niceCeiling(high) : 0
  const min = low < 0 ? -niceCeiling(-low) : 0
  return max === min ? { min, max: min + 1 } : { min, max }
}

function niceCeiling(value: number): number {
  if (value <= 0) return 1
  const step = 10 ** Math.floor(Math.log10(value))
  const units = value / step
  const nice = units <= 1 ? 1 : units <= 2 ? 2 : units <= 5 ? 5 : 10
  return nice * step
}
