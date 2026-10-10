import { useState, type ReactNode } from 'react'
import type { GenUiNode, GenUiRender } from '../../../../src/core/genui.ts'
import { evaluateFormula, formatNumber, interpolate, type GenUiValues } from './evaluate.js'

/**
 * A generated interface: the tree the model asked for, drawn with the app's own
 * pieces.
 *
 * The inputs hold their values here, in one map keyed by id, and every `text` and
 * `stat` reads from it — so moving a slider updates the numbers beside it without
 * a call to anyone. A `button` is the only way out of the widget: pressing it
 * sends its message as a new turn, which is the single door back to the model.
 */
export function GenUi({ render, onSend }: { render: GenUiRender; onSend?(text: string): void }) {
  const [values, setValues] = useState<GenUiValues>(() => initialValues(render.tree))
  const set = (id: string, value: number | string | boolean): void =>
    setValues((current) => ({ ...current, [id]: value }))

  return (
    <div className="genui">
      {render.title && <div className="genui-title">{render.title}</div>}
      <Node node={render.tree} values={values} set={set} onSend={onSend} />
    </div>
  )
}

function Node({
  node,
  values,
  set,
  onSend,
}: {
  node: GenUiNode
  values: GenUiValues
  set(id: string, value: number | string | boolean): void
  onSend?(text: string): void
}): ReactNode {
  if (node.kind === 'box') {
    const children = uniqueKeys(node.children.map(nodeKey))
    return (
      <div className={`genui-box ${node.direction === 'row' ? 'row' : 'column'}${node.gap ? ` genui-gap-${node.gap}` : ''}${node.padding ? ` genui-pad-${node.padding}` : ''}`}>
        {node.children.map((child, index) => (
          <Node key={children[index]} node={child} values={values} set={set} onSend={onSend} />
        ))}
      </div>
    )
  }
  if (node.kind === 'title') return <div className={`genui-title genui-size-${node.size ?? 'md'}`}>{node.text}</div>
  if (node.kind === 'text') return <p className="genui-text">{interpolate(node.text, values)}</p>
  if (node.kind === 'stat') {
    const value = evaluateFormula(node.formula, values)
    const shown = value === null ? '—' : `${node.prefix ?? ''}${formatNumber(value, node.decimals)}${node.suffix ?? ''}`
    return (
      <div className="genui-stat">
        <span className="genui-stat-value">{shown}</span>
        <span className="genui-stat-label">{node.label}</span>
      </div>
    )
  }
  if (node.kind === 'table') {
    const columns = uniqueKeys(node.columns)
    const rows = uniqueKeys(node.rows.map((row) => row.join('\u0000')))
    return (
      <table className="genui-grid">
        <thead>
          <tr>{node.columns.map((column, index) => <th key={columns[index]}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {node.rows.map((row, index) => (
            <tr key={rows[index]}>
              {node.columns.map((_, column) => <td key={columns[column]}>{row[column] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (node.kind === 'list') {
    const items = uniqueKeys(node.items)
    return <ul className="genui-list">{node.items.map((item, index) => <li key={items[index]}>{item}</li>)}</ul>
  }
  if (node.kind === 'steps') {
    const keys = uniqueKeys(node.entries.map((entry) => `${entry.title}\u0000${entry.detail ?? ''}`))
    return (
      <div className="genui-steps">
        {node.title && <div className="genui-steps-title">{node.title}</div>}
        <ol className="genui-steps-list">
          {node.entries.map((entry, index) => (
            <li className="genui-step" key={keys[index]}>
              <span className="genui-step-num" aria-hidden="true">{index + 1}</span>
              <span className="genui-step-body">
                <span className="genui-step-title">{entry.title}</span>
                {entry.detail && <span className="genui-step-detail">{entry.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
    )
  }
  if (node.kind === 'facts') {
    const keys = uniqueKeys(node.entries.map((entry) => `${entry.label}\u0000${entry.value}`))
    return (
      <div className="genui-facts">
        {node.title && <div className="genui-facts-title">{node.title}</div>}
        <dl className="genui-facts-list">
          {node.entries.map((entry, index) => (
            <div className="genui-fact" key={keys[index]}>
              <dt className="genui-fact-label">{entry.label}</dt>
              <dd className="genui-fact-value">{entry.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }
  if (node.kind === 'button') {
    return <button className="genui-action" type="button" onClick={() => onSend?.(interpolate(node.send, values))}>{node.label}</button>
  }
  if (node.kind === 'slider') {
    const value = numeric(values[node.id], node.value)
    return (
      <label className="genui-field">
        <span className="genui-field-label">{node.label}</span>
        <span className="genui-field-row">
          <input className="genui-slider" type="range" min={node.min} max={node.max} step={node.step ?? 1} value={value} onChange={(event) => set(node.id, Number(event.target.value))} />
          <span className="genui-field-value">{node.prefix ?? ''}{formatNumber(value)}{node.suffix ?? ''}</span>
        </span>
      </label>
    )
  }
  if (node.kind === 'number') {
    const value = numeric(values[node.id], node.value)
    return (
      <label className="genui-field">
        <span className="genui-field-label">{node.label}</span>
        <span className="genui-field-row">
          <input className="genui-number" type="number" value={value} min={node.min} max={node.max} onChange={(event) => set(node.id, Number(event.target.value))} />
          {(node.prefix || node.suffix) && <span className="genui-field-value">{node.prefix ?? ''}{node.suffix ?? ''}</span>}
        </span>
      </label>
    )
  }
  if (node.kind === 'checkbox') {
    return (
      <label className="genui-field genui-field-inline">
        <input className="genui-check" type="checkbox" checked={Boolean(values[node.id] ?? node.value)} onChange={(event) => set(node.id, event.target.checked)} />
        <span className="genui-field-label">{node.label}</span>
      </label>
    )
  }
  return (
    <label className="genui-field">
      <span className="genui-field-label">{node.label}</span>
      <select className="genui-select" value={String(values[node.id] ?? node.value)} onChange={(event) => set(node.id, event.target.value)}>
        {node.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  )
}

/** The starting values of a tree: every input's own default, by id. */
function initialValues(node: GenUiNode): GenUiValues {
  const values: GenUiValues = {}
  collect(node, values)
  return values
}

function collect(node: GenUiNode, values: GenUiValues): void {
  if (node.kind === 'box') {
    for (const child of node.children) collect(child, values)
    return
  }
  if (node.kind === 'slider' || node.kind === 'number') values[node.id] = node.value
  else if (node.kind === 'checkbox') values[node.id] = node.value ?? false
  else if (node.kind === 'select') values[node.id] = node.value
}

/** The number an input holds now, or the value it was given. */
function numeric(value: number | string | boolean | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A stable name for a node, so a re-render does not lose a row's identity. The
 * parts only ever append and a tree never reorders, but a key still has to be
 * derived from content rather than from a position — the house rule for every
 * list drawn on this surface.
 */
function nodeKey(node: GenUiNode): string {
  if (node.kind === 'title' || node.kind === 'text') return `${node.kind}:${node.text.slice(0, 40)}`
  if (node.kind === 'button') return `button:${node.label}`
  if (node.kind === 'stat') return `stat:${node.label}`
  if (node.kind === 'table') return `table:${node.columns.join('/')}`
  if (node.kind === 'list') return `list:${node.items.length}`
  if (node.kind === 'steps') return `steps:${node.entries.length}`
  if (node.kind === 'facts') return `facts:${node.entries.length}`
  if (node.kind === 'box') return `box:${node.children.length}`
  return `${node.kind}:${node.id}`
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
