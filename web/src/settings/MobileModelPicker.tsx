import { useState } from 'react'
import type { ModelInfo } from '../../../src/core/providers/models.js'
import { Icon } from '../ui/Icons.js'
import { ModelDetails } from '../ui/ModelDetails.js'

type Preset = { id: string; name: string; models: string[] }

/**
 * Mobile model picker sheet: a full-height overlay with provider chips,
 * search input, and a scrollable model list with detail badges.
 */
export function MobileModelSheet({
  presets,
  provider,
  model,
  browsing,
  catalog,
  onBrowse,
  onPick,
  onClose,
}: {
  presets: Preset[]
  provider: string
  model: string
  browsing: string
  catalog: ModelInfo[] | null
  onBrowse(provider: string): void
  onPick(model: string): void
  onClose(): void
}) {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const shown = (catalog ?? []).filter((item) =>
    `${item.id} ${item.name ?? ''}`.toLowerCase().includes(query),
  )

  return (
    <div className="mobile-model-sheet" role="dialog" aria-label="Select model">
      <header className="mobile-model-sheet-head">
        <button
          className="settings-strip-back"
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <Icon name="arrow-left" size={17} />
        </button>
        <h2>Select model</h2>
      </header>

      <div className="mobile-model-chips" role="tablist" aria-label="Providers">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="tab"
            aria-selected={preset.id === browsing}
            className={`mobile-model-chip ${preset.id === browsing ? 'active' : ''}`}
            onClick={() => onBrowse(preset.id)}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="mobile-model-search-wrap">
        <label className="model-picker-search">
          <Icon name="search" size={14} />
          <input
            aria-label="Filter models"
            placeholder="Filter models"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          {filter && (
            <button
              type="button"
              className="icon-button"
              aria-label="Clear filter"
              onClick={() => setFilter('')}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </label>
      </div>

      <div className="mobile-model-list">
        {catalog === null ? (
          <p className="model-picker-note">Reading this provider’s models…</p>
        ) : shown.length === 0 ? (
          <p className="model-picker-note">
            {catalog.length === 0
              ? 'This provider reports no models. Type an id in the field below if you know it.'
              : 'No model matches that.'}
          </p>
        ) : (
          shown.map((item) => {
            const isChosen = item.id === model && browsing === provider
            return (
              <button
                key={item.id}
                type="button"
                className={`mobile-model-item ${isChosen ? 'chosen' : ''}`}
                aria-current={isChosen ? 'true' : undefined}
                onClick={() => {
                  onPick(item.id)
                  onClose()
                }}
              >
                <div className="mobile-model-item-main">
                  <span className="mobile-model-item-id">{item.id}</span>
                  <ModelDetails model={item} />
                </div>
                {isChosen && <Icon name="check" size={16} />}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
