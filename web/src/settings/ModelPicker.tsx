import { useState } from 'react'
import type { ModelInfo } from '../../../src/core/providers/models.js'
import { Icon } from '../ui/Icons.js'
import { ModelDetails } from '../ui/ModelDetails.js'

type Preset = { id: string; name: string; models: string[] }

/**
 * Choosing which model answers, on a screen wide enough for two columns: the
 * providers on the left, the models of the one being looked at on the right.
 * Clicking a provider only shows its list — the choice is the model, which fixes
 * the pair at once — so nothing in the draft moves while the person browses, and
 * what is set stays marked wherever the eye goes.
 */
export function ModelPicker({ presets, provider, model, browsing, catalog, onBrowse, onPick }: {
  presets: Preset[]
  /** What the draft is set to, marked whether or not it is the one being shown. */
  provider: string
  model: string
  browsing: string
  /** Null until the looked-at provider's catalog has been read. */
  catalog: ModelInfo[] | null
  onBrowse(provider: string): void
  onPick(model: string): void
}) {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const shown = (catalog ?? []).filter((item) => `${item.id} ${item.name ?? ''}`.toLowerCase().includes(query))

  return <div className="model-picker">
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
          : shown.length === 0 ? <p className="model-picker-note">{catalog.length === 0 ? 'This provider reports no models. Type an id below if you know it.' : 'No model matches that.'}</p>
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
