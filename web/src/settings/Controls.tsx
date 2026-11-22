import type { ReactNode } from 'react'

/** A titled surface grouping related settings rows with hairline dividers between them. */
export function SettingsGroup({
  title,
  meta,
  action,
  footer,
  id,
  children,
}: {
  title?: string
  meta?: ReactNode
  action?: ReactNode
  footer?: ReactNode
  id?: string
  children: ReactNode
}) {
  return (
    <section className="settings-group" aria-labelledby={id}>
      {(title || meta || action) && (
        <div className="settings-group-head">
          <div className="settings-group-head-left">
            {title && <h3 id={id} className="settings-group-title">{title}</h3>}
            {meta && <span className="settings-group-meta">{meta}</span>}
          </div>
          {action && <div className="settings-group-action">{action}</div>}
        </div>
      )}
      <div className="settings-group-body">{children}</div>
      {footer && <div className="settings-group-footer">{footer}</div>}
    </section>
  )
}

/** A horizontal setting row: label and optional description on the left, control on the right. */
export function SettingRow({
  label,
  description,
  badge,
  children,
  htmlFor,
  disabled = false,
}: {
  label: ReactNode
  description?: ReactNode
  badge?: ReactNode
  children: ReactNode
  htmlFor?: string
  disabled?: boolean
}) {
  return (
    <div className={`settings-row${disabled ? ' is-disabled' : ''}`}>
      <div className="settings-row-info">
        {htmlFor ? (
          <label className="settings-row-label" htmlFor={htmlFor}>
            <span>{label}</span>
            {badge}
          </label>
        ) : (
          <div className="settings-row-label">
            <span>{label}</span>
            {badge}
          </div>
        )}
        {description && <p className="settings-row-desc">{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/** A full-width stacked row inside a SettingsGroup, for text fields, URLs, or comma-separated lists. */
export function SettingStack({
  label,
  description,
  htmlFor,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="settings-row settings-row-stack">
      <div className="settings-row-info">
        {htmlFor ? (
          <label className="settings-row-label" htmlFor={htmlFor}>{label}</label>
        ) : (
          <div className="settings-row-label">{label}</div>
        )}
        {description && <p className="settings-row-desc">{description}</p>}
      </div>
      <div className="settings-row-field">{children}</div>
    </div>
  )
}

/** Filled pill switch used for every boolean setting across Settings. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange(next: boolean): void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  )
}

/** Compact filled segmented control for 2–4 mutually exclusive options. */
export function Segmented<T extends string>({
  value,
  choices,
  onChange,
  label,
}: {
  value: T
  choices: ReadonlyArray<{ value: T; label: string }>
  onChange(next: T): void
  label: string
}) {
  return (
    <fieldset className="settings-segmented" aria-label={label}>
      {choices.map((choice) => {
        const active = choice.value === value
        return (
          <button
            key={choice.value}
            type="button"
            aria-pressed={active}
            className={`settings-segmented-item${active ? ' active' : ''}`}
            onClick={() => onChange(choice.value)}
          >
            {choice.label}
          </button>
        )
      })}
    </fieldset>
  )
}

/** Collapsible disclosure for secondary/advanced settings and setup guides. */
export function Disclosure({
  label,
  meta,
  defaultOpen = false,
  children,
}: {
  label: string
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <details className="settings-disclosure" open={defaultOpen || undefined}>
      <summary className="settings-disclosure-summary">
        <span className="settings-disclosure-label">{label}</span>
        {meta && <span className="settings-disclosure-meta">{meta}</span>}
      </summary>
      <div className="settings-disclosure-body">{children}</div>
    </details>
  )
}
