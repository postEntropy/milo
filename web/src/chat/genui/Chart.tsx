import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type { GenUiChart } from '../../../../src/core/genui.ts'
import { chartBounds } from './chart-bounds.js'
import { formatNumber } from './evaluate.js'

/** The two series a chart may carry, in the palette's own hierarchy. */
const COLORS = ['var(--accent)', 'var(--secondary)']

/**
 * A series drawn as a shape — the one part of a widget whose point is the trend
 * rather than the numbers. It is an SVG built here, not a charting library: a dozen
 * points and two series do not need one, and the look stays the product's own.
 *
 * Dragging across it reads the nearest point (the label and every series' value),
 * which is what makes a dense line legible on a phone-sized column.
 */
export function Chart({ node }: { node: GenUiChart }) {
  const host = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(320)
  const [at, setAt] = useState<number | null>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(180, Math.round(entry.contentRect.width)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const height = node.height === 'sm' ? 78 : node.height === 'lg' ? 168 : 120
  const top = 12
  const bottom = height - 20
  const plot = bottom - top
  const left = 36
  const plotWidth = Math.max(40, width - left)
  const count = node.labels.length
  const band = plotWidth / count
  const center = (index: number): number => left + band * index + band / 2
  const bounds = chartBounds(node.series.map((entry) => entry.values), node.type === 'bar')
  const y = (value: number): number => top + (1 - (value - bounds.min) / (bounds.max - bounds.min)) * plot
  const floor = y(bounds.min)
  const baseline = y(Math.min(bounds.max, Math.max(bounds.min, 0)))

  // Every key is derived from what the line or point says, never from its position:
  // a draft replaces the tree ten times a second and a row's identity has to survive
  // it. `uniqueKeys` makes a repeated label a key of its own.
  const labelKeys = uniqueKeys(node.labels)
  const seriesKeys = uniqueKeys(node.series.map((entry, index) => entry.label ?? `Series ${index + 1}`))
  const series = node.series.map((entry, index) => ({
    entry,
    key: seriesKeys[index]!,
    color: COLORS[index % COLORS.length],
    place: index,
    delay: index * 60,
  }))
  const labels = node.labels.map((label, index) => ({ label, key: labelKeys[index]! }))
  const bars =
    node.type === 'bar'
      ? series.flatMap(({ entry, key, color, place }) =>
          entry.values.map((value, index) => ({
            value,
            index,
            color,
            delay: index * 18,
            key: `${key}-${labelKeys[index]!}`,
            x: center(index) - (band * 0.62) / 2 + place * ((band * 0.62) / node.series.length),
          })),
        )
      : []
  const points =
    at === null
      ? []
      : series.map(({ entry, key, color }) => ({ key, color, value: entry.values[at] ?? 0 }))

  const fmt = (value: number): string =>
    `${node.prefix ?? ''}${formatNumber(value, node.decimals)}${node.suffix ?? ''}`

  const line = (values: number[]): string =>
    values.map((value, index) => `${index === 0 ? 'M' : 'L'}${center(index)},${y(value)}`).join(' ')

  const area = (values: number[]): string =>
    `M${center(0)},${floor} ${values.map((value, index) => `L${center(index)},${y(value)}`).join(' ')} L${center(count - 1)},${floor} Z`

  const read = (event: ReactPointerEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * width
    const index = Math.floor((x - left) / band)
    setAt(Math.min(count - 1, Math.max(0, index)))
  }

  const summary = node.series
    .map((entry, index) => {
      const name = entry.label ?? `Series ${index + 1}`
      return `${name}: ${node.labels.map((label, point) => `${label} ${fmt(entry.values[point] ?? 0)}`).join(', ')}`
    })
    .join('. ')

  return (
    <div className="genui-chart" ref={host}>
      <div className="genui-chart-read">
        {at === null ? (
          series.map(({ entry, key, color }) => (
            <span className="genui-chart-pair" key={key}>
              <span className="genui-chart-dot" style={{ background: color }} aria-hidden="true" />
              {entry.label && <span className="genui-chart-series">{entry.label}</span>}
            </span>
          ))
        ) : (
          <>
            <span className="genui-chart-label">{node.labels[at]}</span>
            {series.map(({ entry, key, color }) => (
              <span className="genui-chart-pair" key={key}>
                <span className="genui-chart-dot" style={{ background: color }} aria-hidden="true" />
                {entry.label && <span className="genui-chart-series">{entry.label}</span>}
                <span className="genui-chart-number">{fmt(entry.values[at] ?? 0)}</span>
              </span>
            ))}
          </>
        )}
      </div>
      <svg
        className="genui-chart-svg"
        width={width}
        height={height}
        role="img"
        aria-label={`${node.type} chart. ${summary}`}
        onPointerMove={read}
        onPointerDown={read}
        onPointerLeave={() => setAt(null)}
      >
        {[0, 0.5, 1].map((fraction) => (
          <line
            key={`grid-${fraction}`}
            className="genui-chart-grid"
            x1={left}
            x2={width}
            y1={top + fraction * plot}
            y2={top + fraction * plot}
          />
        ))}
        <text className="genui-chart-tick" x={left - 6} y={top + 4} textAnchor="end">
          {fmt(bounds.max)}
        </text>
        <text className="genui-chart-tick" x={left - 6} y={bottom} textAnchor="end">
          {fmt(bounds.min)}
        </text>

        {node.type === 'bar'
          ? bars.map((bar) => {
              const valueY = y(bar.value)
              return (
                <rect
                  key={bar.key}
                  className="genui-chart-bar"
                  x={bar.x}
                  y={bar.value >= 0 ? valueY : baseline}
                  width={Math.max(2, (band * 0.62) / node.series.length - 2)}
                  height={Math.max(1, Math.abs(valueY - baseline))}
                  rx={3}
                  fill={bar.color}
                  style={{ animationDelay: `${bar.delay}ms` } as CSSProperties}
                />
              )
            })
          : series.map(({ entry, key, color, delay }) => (
              <g key={key}>
                {node.type === 'area' && (
                  <path
                    className="genui-chart-area"
                    d={area(entry.values)}
                    fill={color}
                    style={{ animationDelay: `${delay}ms` }}
                  />
                )}
                <path
                  className="genui-chart-line"
                  d={line(entry.values)}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                  style={{ animationDelay: `${delay}ms` }}
                />
              </g>
            ))}

        {node.type === 'bar' && baseline > top && <line className="genui-chart-base" x1={left} x2={width} y1={baseline} y2={baseline} />}

        {labels.map((item, index) => (
          <text
            key={item.key}
            className="genui-chart-x"
            x={center(index)}
            y={height - 5}
            textAnchor="middle"
          >
            {short(count > 7 && index % 2 === 1 ? '' : item.label)}
          </text>
        ))}

        {at !== null && (
          <g className="genui-chart-mark">
            <line x1={center(at)} x2={center(at)} y1={top} y2={bottom} />
            {points.map((point) => (
              <circle key={point.key} cx={center(at)} cy={y(point.value)} r={3.5} fill={point.color} />
            ))}
          </g>
        )}
      </svg>
    </div>
  )
}

/** A small line with no axes: the shape under a figure that already says the number. */
export function Sparkline({ values, tone }: { values: number[]; tone?: 'good' | 'bad' | 'neutral' }) {
  const width = 92
  const height = 26
  const pad = 2
  const bounds = chartBounds([values], false)
  const x = (index: number): number => pad + (index / (values.length - 1)) * (width - pad * 2)
  const y = (value: number): number => pad + (1 - (value - bounds.min) / (bounds.max - bounds.min)) * (height - pad * 2)
  const path = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`).join(' ')
  const stroke = tone === 'good' ? 'var(--success)' : tone === 'bad' ? 'var(--danger)' : 'var(--muted)'
  return (
    <svg className="genui-sparkline" width={width} height={height} aria-hidden="true">
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
    </svg>
  )
}

function short(text: string): string {
  if (text === '') return ''
  return text.length > 8 ? `${text.slice(0, 7)}…` : text
}

/** Makes a list of labels unique, so two identical rows do not share a key. */
function uniqueKeys(labels: string[]): string[] {
  const seen = new Map<string, number>()
  return labels.map((label) => {
    const occurrence = seen.get(label) ?? 0
    seen.set(label, occurrence + 1)
    return occurrence === 0 ? label : `${label}#${occurrence}`
  })
}
