import type { CSSProperties } from 'react'
import { EFFORT_LEVELS } from '@protocol'
import { EFFORT_LABELS } from '../lib/labels.js'

type Effort = (typeof EFFORT_LEVELS)[number]

/**
 * How hard the model thinks, as one slider with a stop per level: the composer's model
 * panel and the settings screen ask the same question in the same shape, and the choice
 * applies as the thumb moves. The labels under the track are the reading of the stop the
 * thumb sits on — the slider itself already carries the value for a screen reader.
 */
export function ReasoningSlider({ id, value, onChange }: {
  /** Wired to the field's own label where a `Field` wraps this. */
  id?: string
  value: Effort
  onChange(value: Effort): void
}) {
  const at = Math.max(0, EFFORT_LEVELS.indexOf(value))
  return <div className="reasoning-slider">
    <div className="reasoning-slider-track">
    <input
      id={id}
      type="range"
      min={0}
      max={EFFORT_LEVELS.length - 1}
      step={1}
      value={at}
      style={{ '--p': at / (EFFORT_LEVELS.length - 1) } as CSSProperties}
      aria-label="Reasoning effort"
      aria-valuetext={EFFORT_LABELS[value]}
      onChange={(event) => {
        const next = EFFORT_LEVELS[Number(event.target.value)]
        if (next) onChange(next)
      }}
    />
    {EFFORT_LEVELS.map((level, index) => <span
      key={level}
      className="reasoning-slider-dot"
      data-on={index <= at ? 'true' : undefined}
      data-current={index === at ? 'true' : undefined}
      style={{ left: `calc(15px + (100% - 30px) * ${index / (EFFORT_LEVELS.length - 1)})` }}
    />)}
    </div>
    <div className="reasoning-slider-stops" aria-hidden="true">
      {EFFORT_LEVELS.map((level) => <span
        key={level}
        data-on={level === value ? 'true' : undefined}
      >{EFFORT_LABELS[level]}</span>)}
    </div>
  </div>
}
