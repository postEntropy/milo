import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Icon } from './Icons.js'

export type Choice = {
  value: string
  /** What the row and the trigger read. */
  label: string
  /** A short measure that belongs to the label, e.g. how much a model holds. */
  badge?: string
  /** Compact details for choices such as model input capabilities. */
  meta?: ReactNode
}

/**
 * The app's own dropdown: a filled trigger that opens a list, with a filter once
 * the list is long enough to want one. It stands in for the native `<select>` so
 * every menu in the product looks and behaves the same — the composer's model
 * picker included, which is this wearing a pill.
 */
export function Select({
  id,
  value,
  choices,
  onChange,
  label,
  className = '',
  searchFrom = 8,
  note,
  icon,
  caret = true,
  triggerLabel,
  filterExtra,
  foot,
  onOpen,
  onClose,
}: {
  id?: string
  value: string
  choices: Choice[]
  onChange(value: string): void
  /** What the list is called, read out when it opens. */
  label: string
  /** Extra class for the trigger, where it is not a plain field. */
  className?: string
  /** How many entries before the filter appears. */
  searchFrom?: number
  /** What to say instead of the list when there is nothing to show. */
  note?: ReactNode
  /** A mark to lead the trigger with, where the trigger is a pill. */
  icon?: Parameters<typeof Icon>[0]['name']
  /** A caret says a control opens something; only where there is no room for it. */
  caret?: boolean
  /** What the trigger reads, when the chosen row's own label is not it. */
  triggerLabel?: string
  /**
   * A control that lives in the filter row, at its end — e.g. the composer's
   * provider select, sharing the row with the search. It brings the row with it
   * even when the list is short enough to have no filter of its own.
   */
  filterExtra?: ReactNode
  /**
   * Content pinned at the foot of the menu, under the scrolling rows — where a
   * control that belongs to the same panel lives, e.g. the phone picker's row of
   * reasoning-effort segments below the model list.
   */
  foot?: ReactNode
  onOpen?(): void
  onClose?(): void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlight, setHighlight] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const current = choices.find((choice) => choice.value === value)
  const query = filter.trim().toLowerCase()
  const shown = query
    ? choices.filter((choice) => `${choice.value} ${choice.label}`.toLowerCase().includes(query))
    : choices

  const close = useCallback((): void => {
    setOpen(false)
    onClose?.()
  }, [onClose])

  // Opened, the menu is the only thing that takes a click: anywhere else is the
  // way out, the same as pressing Escape.
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  function expand(): void {
    setFilter('')
    setHighlight(Math.max(0, choices.findIndex((choice) => choice.value === value)))
    setOpen(true)
    onOpen?.()
  }

  function pick(next: string): void {
    onChange(next)
    close()
    trigger.current?.focus()
  }

  /** One keyboard model for the whole widget, whether the filter has the focus. */
  function key(event: ReactKeyboardEvent): void {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      trigger.current?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((at) => {
        const step = event.key === 'ArrowDown' ? 1 : -1
        return (at + step + shown.length) % Math.max(shown.length, 1)
      })
      return
    }
    if (event.key === 'Enter' && shown[highlight]) {
      event.preventDefault()
      pick(shown[highlight].value)
    }
  }

  return <div className={`select ${open ? 'is-open' : ''}`} ref={box}>
    <button
      id={id}
      ref={trigger}
      type="button"
      className={`select-trigger ${className}`}
      aria-haspopup="listbox"
      aria-expanded={open}
      onClick={() => (open ? close() : expand())}
      onKeyDown={(event) => {
        if (open) {
          key(event)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          expand()
        }
      }}
    >
      {icon && <Icon name={icon} size={13} />}
      <span className="select-value">{triggerLabel ?? current?.label ?? value}</span>
      {current?.meta}
      {caret && <Icon className="select-caret" name="chevron" size={15} />}
    </button>
    {open && <div className="select-menu" role="listbox" aria-label={label}>
      {(filterExtra || choices.length >= searchFrom) && <div className="select-head">
        {choices.length >= searchFrom && <label className="select-search">
          <Icon name="search" size={14} />
          <input
            ref={search}
            aria-label={`Filter ${label.toLowerCase()}`}
            placeholder="Filter"
            value={filter}
            onChange={(event) => { setFilter(event.target.value); setHighlight(0) }}
            onKeyDown={key}
          />
        </label>}
        {filterExtra}
      </div>}
      <div className="select-options">
        {shown.length === 0
          ? <div className="select-note">{note ?? 'Nothing here.'}</div>
          : shown.map((choice, index) => <button
            key={choice.value}
            type="button"
            role="option"
            aria-selected={choice.value === value}
            className={`select-option ${index === highlight ? 'active' : ''} ${choice.value === value ? 'chosen' : ''}`}
            onMouseEnter={() => setHighlight(index)}
            onClick={() => pick(choice.value)}
          >
            <span className="select-option-label">{choice.label}</span>
            {choice.meta}
            {choice.badge ? <span className="size-badge">{choice.badge}</span> : null}
            {choice.value === value ? <Icon name="check" size={14} /> : null}
          </button>)}
      </div>
      {foot}
    </div>}
  </div>
}
