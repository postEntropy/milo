import { useState, type ReactNode } from 'react'
import type { ModelInfo } from '../../../src/core/providers/models.js'
import { Icon } from './Icons.js'
import { ModelDetails } from './ModelDetails.js'

type Preset = { id: string; name: string }

/**
 * Choosing which model answers, on a screen wide enough for two columns: the
 * providers on the left, the models of the one being looked at on the right.
 * Clicking a provider only shows its list — the choice is the model, which fixes
 * the pair at once — so nothing that is set moves while the person browses, and
 * what is set stays marked wherever the eye goes.
 *
 * The settings screen and the composer's model pill both draw it. The caller
 * names the container, so the same panes are a section there and a menu here.
 */
export function ModelPicker({ presets, provider, model, browsing, catalog, onBrowse, onPick, className = 'model-picker', note }: {
  presets: Preset[]
  /** What is set, marked whether or not it is the one being shown. */
  provider: string
  model: string
  /** The provider being looked at, whose catalog is the list on the right. */
  browsing: string
  /** Null until the looked-at provider's catalog has been read. */
  catalog: ModelInfo[] | null
  onBrowse(provider: string): void
  onPick(model: string): void
  /** The container's own class: the settings screen names it, the composer names it. */
  className?: string
  /** Why the list is empty, where the caller knows: the composer says what failed. */
  note?: ReactNode
}) {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const shown = (catalog ?? []).filter((item) => `${item.id} ${item.name ?? ''}`.toLowerCase().includes(query))

  return <div className={className}>
    <div className="model-picker-pane">
      <h3>Providers</h3>
      <div className="model-picker-list">
        {presets.map((preset) => <button
          key={preset.id}
          type="button"
          className={`model-picker-row ${preset.id === browsing ? 'browsing' : ''} ${preset.id === provider ? 'chosen' : ''}`}
          aria-current={preset.id === provider ? 'true' : undefined}
          onClick={() => onBrowse(preset.id)}
        >
          <span className="model-picker-name">{preset.name}</span>
          {preset.id === provider && <Icon name="check" size={14} />}
        </button>)}
      </div>
    </div>
    <div className="model-picker-pane">
      <h3>Models</h3>
      <label className="model-picker-search">
        <Icon name="search" size={14} />
        <input aria-label="Filter models" placeholder="Filter models" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      <div className="model-picker-list">
        {catalog === null ? <p className="model-picker-note">Reading this provider’s models…</p>
          : shown.length === 0 ? <p className="model-picker-note">{catalog.length === 0 ? note ?? 'This provider reports no models. Type an id below if you know it.' : 'No model matches that.'}</p>
            : shown.map((item) => <button
              key={item.id}
              type="button"
              className={`model-picker-row ${item.id === model && browsing === provider ? 'chosen' : ''}`}
              aria-current={item.id === model && browsing === provider ? 'true' : undefined}
              onClick={() => onPick(item.id)}
            >
              <span className="model-picker-name">{item.id}</span>
              <ModelDetails model={item} />
              <span className="model-picker-tail">
                {item.id === model && browsing === provider ? <Icon name="check" size={14} /> : null}
              </span>
            </button>)}
      </div>
    </div>
  </div>
}
