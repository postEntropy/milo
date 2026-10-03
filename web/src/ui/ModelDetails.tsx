import { knownInputModalities, type InputModality, type ModelInfo } from '../../../src/core/providers/models.js'
import { formatContext } from '../../../src/gateways/model-label.ts'
import { Icon, type IconName } from './Icons.js'

const MODALITIES: Array<{ id: InputModality; icon: IconName; label: string }> = [
  { id: 'image', icon: 'eye', label: 'Vision input' },
  { id: 'audio', icon: 'audio', label: 'Audio input' },
  { id: 'file', icon: 'file', label: 'File input' },
]

/** The model's confirmed input types and context window, drawn the same everywhere. */
export function ModelDetails({ model }: { model: ModelInfo }) {
  const modalities = model.inputModalities
    ?? (model.vision !== undefined ? (model.vision ? ['image'] : []) : knownInputModalities(model.id) ?? [])
  const shown = MODALITIES.filter(({ id }) => modalities.includes(id))
  if (shown.length === 0 && !model.context) return null

  return <span className="model-details">
    {shown.length > 0 && <span className="model-modalities">
      {shown.map(({ id, icon, label }) => <span className="model-modality" key={id} title={label} role="img" aria-label={label}>
        <Icon name={icon} size={14} />
      </span>)}
    </span>}
    {model.context ? <span className="size-badge" title="Context window">{formatContext(model.context)}</span> : null}
  </span>
}
