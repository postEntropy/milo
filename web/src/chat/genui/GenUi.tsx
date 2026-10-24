import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  GenUiAccordion,
  GenUiCode,
  GenUiDate,
  GenUiDateRange,
  GenUiMultiselect,
  GenUiNode,
  GenUiProgress,
  GenUiRender,
  GenUiStat,
  GenUiTabs,
} from '../../../../src/core/genui.ts'
import { Code } from '../../ui/Code.js'
import { Chart, Sparkline } from './Chart.js'
import { evaluateFormula, formatNumber, interpolate, type GenUiValues } from './evaluate.js'
import { Inline } from './Inline.js'
import { useCountUp } from './motion.js'

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

  // A draft is the tree as far as it has been written, so an input can arrive after
  // the widget is already on screen. Its default joins the map then — without
  // overwriting a value the person has since set.
  const defaults = useMemo(() => initialValues(render.tree), [render])
  useEffect(() => {
    setValues((current) => {
      let filled = false
      const next = { ...current }
      for (const [id, value] of Object.entries(defaults)) {
        if (!(id in next)) {
          next[id] = value
          filled = true
        }
      }
      return filled ? next : current
    })
  }, [defaults])

  return (
    <div className="genui">
      {render.title && (
        <div className="genui-title">
          <Inline text={render.title} values={values} />
        </div>
      )}
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
    const align = node.align ? ` genui-align-${node.align}` : ''
    const wrap = node.wrap ? ' genui-wrap' : ''
    return (
      <div className={`genui-box ${node.direction === 'row' ? 'row' : 'column'}${node.gap ? ` genui-gap-${node.gap}` : ''}${node.padding ? ` genui-pad-${node.padding}` : ''}${align}${wrap}`}>
        {node.children.map((child, index) => (
          <Node key={children[index]} node={child} values={values} set={set} onSend={onSend} />
        ))}
      </div>
    )
  }
  if (node.kind === 'title') {
    return (
      <div className={`genui-title genui-size-${node.size ?? 'md'}`}>
        <Inline text={node.text} values={values} />
      </div>
    )
  }
  if (node.kind === 'text') {
    return (
      <p className="genui-text">
        <Inline text={node.text} values={values} />
      </p>
    )
  }
  if (node.kind === 'divider') return <hr className="genui-divider" />
  if (node.kind === 'callout') {
    return (
      <div className={`genui-callout genui-tone-${node.tone ?? 'info'}`}>
        <span className="genui-callout-mark" aria-hidden="true">{calloutMark(node.tone)}</span>
        <span className="genui-callout-body">
          {node.title && (
            <span className="genui-callout-title">
              <Inline text={node.title} values={values} />
            </span>
          )}
          <span className="genui-callout-text">
            <Inline text={node.text} values={values} />
          </span>
        </span>
      </div>
    )
  }
  if (node.kind === 'badge') {
    return (
      <span className={`genui-badge genui-tone-${node.tone ?? 'neutral'}`}>
        <Inline text={node.label} values={values} />
      </span>
    )
  }
  if (node.kind === 'chart') return <Chart node={node} />
  if (node.kind === 'stat') return <StatView node={node} values={values} />
  if (node.kind === 'progress') return <ProgressView node={node} values={values} />
  if (node.kind === 'table') {
    const columns = uniqueKeys(node.columns)
    const rows = uniqueKeys(node.rows.map((row) => row.join('\u0000')))
    return (
      <table className="genui-grid">
        <thead>
          <tr>
            {node.columns.map((column, index) => (
              <th key={columns[index]} className={alignClass(node.align?.[index], column)}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {node.rows.map((row, index) => (
            <tr key={rows[index]}>
              {node.columns.map((_, column) => (
                <td key={columns[column]} data-label={node.columns[column]} className={alignClass(node.align?.[column], row[column] ?? '')}>
                  <Inline text={row[column] ?? ''} values={values} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (node.kind === 'list') {
    const items = uniqueKeys(node.items)
    return (
      <ul className="genui-list">
        {node.items.map((item, index) => (
          <li key={items[index]}>
            <Inline text={item} values={values} />
          </li>
        ))}
      </ul>
    )
  }
  if (node.kind === 'steps') {
    const keys = uniqueKeys(node.entries.map((entry) => `${entry.title}\u0000${entry.detail ?? ''}\u0000${entry.when ?? ''}`))
    return (
      <div className="genui-steps">
        {node.title && <div className="genui-steps-title">{node.title}</div>}
        <ol className="genui-steps-list">
          {node.entries.map((entry, index) => (
            <li className="genui-step" key={keys[index]}>
              <span className="genui-step-num" aria-hidden="true">{index + 1}</span>
              <span className="genui-step-body">
                <span className="genui-step-title"><Inline text={entry.title} values={values} /></span>
                {entry.detail && (
                  <span className="genui-step-detail"><Inline text={entry.detail} values={values} /></span>
                )}
              </span>
              {entry.when && <span className="genui-step-when">{entry.when}</span>}
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
              <dt className="genui-fact-label"><Inline text={entry.label} values={values} /></dt>
              <dd className={`genui-fact-value${entry.tone ? ` genui-ink-${entry.tone}` : ''}`}>
                <Inline text={entry.value} values={values} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }
  if (node.kind === 'code') return <CodeNode node={node} />
  if (node.kind === 'button') {
    return (
      <button className={`genui-action genui-action-${node.tone ?? 'primary'}`} type="button" onClick={() => onSend?.(interpolate(node.send, values))}>
        {node.label}
      </button>
    )
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
  if (node.kind === 'select') {
    return (
      <label className="genui-field">
        <span className="genui-field-label">{node.label}</span>
        <select className="genui-select" value={String(values[node.id] ?? node.value)} onChange={(event) => set(node.id, event.target.value)}>
          {node.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    )
  }
  if (node.kind === 'multiselect') return <MultiSelect node={node} set={set} />
  if (node.kind === 'date') return <DateField node={node} values={values} set={set} />
  if (node.kind === 'daterange') return <DateRangeField node={node} set={set} />
  if (node.kind === 'tabs') return <TabsView node={node} values={values} set={set} onSend={onSend} />
  return <AccordionView node={node} values={values} set={set} onSend={onSend} />
}

/**
 * A figure that moves with the inputs. The number the surface draws counts to its
 * new value, which is what makes a slider feel connected to the result rather than
 * merely updating it.
 */
function StatView({ node, values }: { node: GenUiStat; values: GenUiValues }) {
  const raw = evaluateFormula(node.formula, values)
  const counted = useCountUp(raw ?? 0)
  const shown = raw === null ? '—' : `${node.prefix ?? ''}${formatNumber(counted, node.decimals)}${node.suffix ?? ''}`
  const delta = node.delta === undefined ? null : evaluateFormula(node.delta, values)
  return (
    <div className="genui-stat">
      <span className="genui-stat-value">{shown}</span>
      <span className="genui-stat-label">{node.label}</span>
      {delta !== null && (
        <span className={`genui-stat-delta genui-ink-${node.deltaTone ?? 'neutral'}`}>
          {delta > 0 ? '+' : delta < 0 ? '−' : ''}{formatNumber(Math.abs(delta))}{node.deltaSuffix ?? ''}
        </span>
      )}
      {node.trend && <Sparkline values={node.trend} tone={node.deltaTone} />}
    </div>
  )
}

/** One figure against a target: a track, and a fill that travels to the value. */
function ProgressView({ node, values }: { node: GenUiProgress; values: GenUiValues }) {
  const value = evaluateFormula(node.formula, values)
  const max = node.max ?? 100
  const ratio = value === null ? 0 : Math.min(1, Math.max(0, value / max))
  return (
    <div className={`genui-progress genui-progress-${node.tone ?? 'accent'}`}>
      <div className="genui-progress-head">
        {node.label && <span className="genui-progress-label">{node.label}</span>}
        <span className="genui-progress-value">
          {value === null ? '—' : `${formatNumber(value)}${node.suffix ?? ''}`}
        </span>
      </div>
      <div className="genui-progress-track">
        <div className="genui-progress-fill" style={{ '--genui-fill': `${ratio * 100}%` } as CSSProperties} />
      </div>
    </div>
  )
}

/** Chips that hold several choices; the message the model reads joins them with commas. */
function MultiSelect({
  node,
  set,
}: {
  node: GenUiMultiselect
  set(id: string, value: number | string | boolean): void
}) {
  const [chosen, setChosen] = useState<string[]>(() => node.values ?? [])
  const toggle = (option: string): void => {
    const next = chosen.includes(option) ? chosen.filter((item) => item !== option) : [...chosen, option]
    setChosen(next)
    set(node.id, next.join(', '))
  }
  return (
    <fieldset className="genui-field genui-chips-field">
      <legend className="genui-field-label">{node.label}</legend>
      <div className="genui-chips">
        {node.options.map((option) => {
          const on = chosen.includes(option)
          return (
            <button
              key={option}
              className={`genui-chip${on ? ' on' : ''}`}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(option)}
            >
              {option}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}

function DateField({
  node,
  values,
  set,
}: {
  node: GenUiDate
  values: GenUiValues
  set(id: string, value: number | string | boolean): void
}) {
  const value = typeof values[node.id] === 'string' ? String(values[node.id]) : node.value
  return (
    <label className="genui-field">
      <span className="genui-field-label">{node.label}</span>
      <input
        className="genui-date"
        type="date"
        value={value}
        min={node.min}
        max={node.max}
        onChange={(event) => set(node.id, event.target.value)}
      />
    </label>
  )
}

/** Two days read as one span: `{id}` shows them as `from – to`. */
function DateRangeField({
  node,
  set,
}: {
  node: GenUiDateRange
  set(id: string, value: number | string | boolean): void
}) {
  const [from, setFrom] = useState(node.from)
  const [to, setTo] = useState(node.to)
  const write = (nextFrom: string, nextTo: string): void => {
    setFrom(nextFrom)
    setTo(nextTo)
    set(node.id, `${nextFrom} – ${nextTo}`)
  }
  return (
    <div className="genui-field">
      <span className="genui-field-label">{node.label}</span>
      <span className="genui-field-row">
        <input className="genui-date" type="date" value={from} min={node.min} max={node.max} aria-label={`${node.label}, from`} onChange={(event) => write(event.target.value, to)} />
        <span className="genui-field-value" aria-hidden="true">–</span>
        <input className="genui-date" type="date" value={to} min={node.min} max={node.max} aria-label={`${node.label}, to`} onChange={(event) => write(from, event.target.value)} />
      </span>
    </div>
  )
}

/** Parts read one at a time, under a filled segmented control. */
function TabsView({
  node,
  values,
  set,
  onSend,
}: {
  node: GenUiTabs
  values: GenUiValues
  set(id: string, value: number | string | boolean): void
  onSend?(text: string): void
}) {
  const [active, setActive] = useState(0)
  const tabKeys = uniqueKeys(node.tabs.map((tab) => tab.label))
  const tabs = node.tabs.map((tab, index) => ({ tab, index, key: tabKeys[index]! }))
  const activeChildren = node.tabs[active]?.children ?? []
  const childKeys = uniqueKeys(activeChildren.map(nodeKey))
  const children = activeChildren.map((child, index) => ({ child, key: childKeys[index]! }))
  return (
    <div className="genui-tabs">
      <div className="genui-tablist" role="tablist">
        {tabs.map(({ tab, index, key }) => (
          <button
            key={key}
            className={`genui-tab${index === active ? ' on' : ''}`}
            type="button"
            role="tab"
            aria-selected={index === active}
            onClick={() => setActive(index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="genui-tabpanel" role="tabpanel" key={active}>
        {children.map(({ child, key }) => (
          <Node key={key} node={child} values={values} set={set} onSend={onSend} />
        ))}
      </div>
    </div>
  )
}

/** Sections folded under their own titles; the first is open unless one says it is. */
function AccordionView({
  node,
  values,
  set,
  onSend,
}: {
  node: GenUiAccordion
  values: GenUiValues
  set(id: string, value: number | string | boolean): void
  onSend?(text: string): void
}) {
  const [open, setOpen] = useState<number[]>(() => {
    const asked = node.items.flatMap((item, index) => (item.open ? [index] : []))
    return asked.length > 0 ? asked : [0]
  })
  const toggle = (index: number): void =>
    setOpen((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]))
  const itemKeys = uniqueKeys(node.items.map((item) => item.title))
  const items = node.items.map((item, index) => ({ item, index, key: itemKeys[index]! }))
  return (
    <div className="genui-accordion">
      {items.map(({ item, index, key }) => {
        const expanded = open.includes(index)
        const childKeys = uniqueKeys(item.children.map(nodeKey))
        const children = item.children.map((child, childIndex) => ({ child, key: childKeys[childIndex]! }))
        return (
          <div className={`genui-accordion-item${expanded ? ' open' : ''}`} key={key}>
            <button className="genui-accordion-head" type="button" aria-expanded={expanded} onClick={() => toggle(index)}>
              <span className="genui-accordion-title">{item.title}</span>
            </button>
            <div className="genui-accordion-body">
              <div className="genui-accordion-inner">
                {children.map(({ child, key: childKey }) => (
                  <Node key={childKey} node={child} values={values} set={set} onSend={onSend} />
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CodeNode({ node }: { node: GenUiCode }) {
  return (
    <pre className="genui-code">
      <code>
        <Code code={node.text} language={node.language} />
      </code>
    </pre>
  )
}

/** The mark a callout wears, from its tone. */
function calloutMark(tone: string | undefined): string {
  if (tone === 'ok') return '✓'
  if (tone === 'warn' || tone === 'danger') return '!'
  return 'i'
}

/**
 * A cell's alignment: what the column asked for, or — for a number, which is the
 * whole reason a column is scanned — the end of its cell.
 */
function alignClass(asked: 'start' | 'end' | undefined, cell: string): string {
  if (asked === 'start') return ''
  if (asked === 'end') return 'genui-cell-end'
  return /^-?[$€£]?[\d.,]+\s*[%A-Za-z]{0,3}$/.test(cell.trim()) ? 'genui-cell-end' : ''
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
  if (node.kind === 'tabs') {
    for (const tab of node.tabs) for (const child of tab.children) collect(child, values)
    return
  }
  if (node.kind === 'accordion') {
    for (const item of node.items) for (const child of item.children) collect(child, values)
    return
  }
  if (node.kind === 'slider' || node.kind === 'number') values[node.id] = node.value
  else if (node.kind === 'checkbox') values[node.id] = node.value ?? false
  else if (node.kind === 'select') values[node.id] = node.value
  else if (node.kind === 'multiselect') values[node.id] = (node.values ?? []).join(', ')
  else if (node.kind === 'date') values[node.id] = node.value
  else if (node.kind === 'daterange') values[node.id] = `${node.from} – ${node.to}`
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
  if (node.kind === 'progress') return `progress:${node.label ?? node.formula}`
  if (node.kind === 'table') return `table:${node.columns.join('/')}`
  if (node.kind === 'list') return `list:${node.items.length}`
  if (node.kind === 'steps') return `steps:${node.entries.length}`
  if (node.kind === 'facts') return `facts:${node.entries.length}`
  if (node.kind === 'box') return `box:${node.children.length}`
  if (node.kind === 'divider') return 'divider'
  if (node.kind === 'callout') return `callout:${node.text.slice(0, 24)}`
  if (node.kind === 'badge') return `badge:${node.label}`
  if (node.kind === 'chart') return `chart:${node.labels.join('/')}`
  if (node.kind === 'code') return `code:${node.language ?? ''}:${node.text.slice(0, 24)}`
  if (node.kind === 'tabs') return `tabs:${node.tabs.map((tab) => tab.label).join('/')}`
  if (node.kind === 'accordion') return `accordion:${node.items.length}`
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
