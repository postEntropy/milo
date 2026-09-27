import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'

/** A labelled field, wiring the label to the control it wraps. */
export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const id = useId()
  return <div className={`field ${className}`}>
    <label htmlFor={id}>{label}</label>
    {Children.map(children, (child) => {
      if (!isValidElement(child)) return child
      const type = child.type
      if (type !== 'input' && type !== 'select' && type !== 'textarea') return child
      return cloneElement(child as ReactElement<{ id?: string }>, { id })
    })}
  </div>
}
