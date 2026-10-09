import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../lib/api.js'
import { formatWhen, message } from '../lib/format.js'
import { Field } from '../ui/Form.js'
import { Icon } from '../ui/Icons.js'
import { Notice, useAutoDismiss } from '../ui/Notice.js'

type TaskItem = { id: string; content: string; completed: boolean; createdAt: number }
type TaskList = { id: string; name: string; createdAt: number; items: TaskItem[] }

/**
 * The task lists surface, drawn like its sibling workspace: the lists as a panel,
 * and one list's own page — its tasks to tick off and its name to change — one
 * level in. Everything lives in the store, so every action reads the whole set
 * back rather than guessing at what it became.
 */
export function TaskLists({ tick }: { tick: number }) {
  const [lists, setLists] = useState<TaskList[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  useAutoDismiss(notice, setNotice)
  const [saving, setSaving] = useState(false)
  /** Why the lists could not be read, held apart from the transient notice so a
      failed read keeps its own sentence and its way to try again. */
  const [loadError, setLoadError] = useState<string | null>(null)

  /** Bumped per read, so a slower earlier answer cannot overwrite a newer one. */
  const loadSeq = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++loadSeq.current
    try {
      const next = await api<TaskList[]>('task-lists')
      if (mine !== loadSeq.current) return
      setLists(next)
      setSelectedId((current) => (current && next.some((list) => list.id === current) ? current : null))
      setLoadError(null)
    } catch (error) {
      if (mine !== loadSeq.current) return
      setLoadError(message(error))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  // A chat turn may have changed a list through Milo; redraw its persisted state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is a change signal only
  useEffect(() => { void refresh() }, [tick, refresh])

  /** One action, the whole set back: the store is the one that decides. */
  const act = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    setSaving(true)
    setNotice(null)
    try {
      const result = await api<{ result: string; lists: TaskList[] }>('task-list-action', body)
      setLists(result.lists)
      setSelectedId((current) => (current && result.lists.some((list) => list.id === current) ? current : null))
      setNotice({ text: result.result, error: false })
      return true
    } catch (error) {
      setNotice({ text: message(error), error: true })
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const selected = lists?.find((list) => list.id === selectedId) ?? null
  const openCount = useMemo(
    () => lists?.reduce((sum, list) => sum + list.items.filter((item) => !item.completed).length, 0) ?? 0,
    [lists],
  )

  if (selected) return <TaskListDetail
    key={selected.id}
    list={selected}
    notice={notice}
    saving={saving}
    onDismiss={() => setNotice(null)}
    onBack={() => setSelectedId(null)}
    onAct={act}
  />
  return <TaskListIndex
    lists={lists}
    openCount={openCount}
    notice={notice}
    loadError={loadError}
    saving={saving}
    onDismiss={() => setNotice(null)}
    onSelect={setSelectedId}
    onCreate={(name) => void act({ action: 'create', name })}
    onRetry={() => { setLoadError(null); void refresh() }}
  />
}

/** The workspace frame, so both levels of this view sit in the same place. */
function Shell({ head, notice, onDismiss, children }: { head: ReactNode; notice: Notice | null; onDismiss(): void; children: ReactNode }) {
  return <main className="settings-workspace">
    <div className="settings-inner">
      <div className="settings-panel-stack">
        <section className="settings-section">
          <div className="panel-head">{head}</div>
          <Notice notice={notice} onDismiss={onDismiss} />
          <div className="panel-body">
            {children}
          </div>
        </section>
      </div>
    </div>
  </main>
}

function TaskListIndex({
  lists,
  openCount,
  notice,
  loadError,
  saving,
  onDismiss,
  onSelect,
  onCreate,
  onRetry,
}: {
  /** Null until the lists have been read once: "none" and "not yet" are not the same. */
  lists: TaskList[] | null
  openCount: number
  notice: Notice | null
  /** Set when the lists could not be read; null once one has been. */
  loadError: string | null
  saving: boolean
  onDismiss(): void
  onSelect(id: string): void
  onCreate(name: string): void
  onRetry(): void
}) {
  return <Shell
    notice={notice}
    onDismiss={onDismiss}
    head={<div className="tasklists-head">
      <div>
        <h2>Task lists</h2>
        <p>Keep the things you and Milo are working on, together across sessions.</p>
      </div>
      {lists && lists.length > 0 && <div className="panel-count"><strong>{openCount}</strong><span>open</span></div>}
    </div>}
  >
    {lists === null
      ? loadError
        ? <div className="panel-state"><p>Could not read your task lists: {loadError}</p><button className="button" type="button" onClick={onRetry}>Try again</button></div>
        : <p className="list-empty">Reading your task lists…</p>
      : lists.length === 0
        ? <div className="panel-empty">
          <span className="panel-empty-mark"><Icon name="list-check" size={22} /></span>
          <h3>No task lists yet</h3>
          <p className="panel-empty-copy">Create a list for a project, an idea, or anything else you want Milo to keep track of with you.</p>
          <TaskListCreate saving={saving} onCreate={onCreate} />
        </div>
        : <div className="tasklist-list">
          {lists.map((list) => <TaskListRow key={list.id} list={list} onClick={() => onSelect(list.id)} />)}
        </div>}
    {lists && lists.length > 0 && <div className="tasklist-footer">
      <TaskListCreate saving={saving} onCreate={onCreate} />
    </div>}
  </Shell>
}

/** One list as the index draws it: its name, what it holds, and how much is left. */
function TaskListRow({ list, onClick }: { list: TaskList; onClick(): void }) {
  const total = list.items.length
  const open = list.items.filter((item) => !item.completed).length
  const activity = list.items.reduce((latest, item) => Math.max(latest, item.createdAt), list.createdAt)
  return <button className="tasklist-card" type="button" onClick={onClick}>
    <span className="tasklist-card-main">
      <span className="tasklist-card-name">{list.name}</span>
      <span className="tasklist-card-meta">{total === 0 ? 'No tasks yet' : `${total} ${total === 1 ? 'task' : 'tasks'} · last added ${formatWhen(activity)}`}</span>
    </span>
    <span className="tasklist-card-count"><span className="tasklist-open">{open}</span><span>open</span></span>
    <Icon className="tasklist-card-chevron" name="chevron" size={16} />
  </button>
}

/** The one field that makes a list, used by the empty state and the list's foot. */
function TaskListCreate({ saving, onCreate }: { saving: boolean; onCreate(name: string): void }) {
  const [name, setName] = useState('')
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed)
    setName('')
  }
  return <form className="tasklist-new" onSubmit={submit}>
    <input className="tasklist-input" aria-label="New list name" placeholder="New list name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
    <button className="button primary" type="submit" disabled={saving || !name.trim()}><Icon name="plus" size={15} /> Create list</button>
  </form>
}

function TaskListDetail({
  list,
  notice,
  saving,
  onDismiss,
  onBack,
  onAct,
}: {
  list: TaskList
  notice: Notice | null
  saving: boolean
  onDismiss(): void
  onBack(): void
  onAct(body: Record<string, unknown>): Promise<boolean>
}) {
  const [newTask, setNewTask] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [rename, setRename] = useState(list.name)

  const todo = list.items.filter((item) => !item.completed)
  const completed = list.items.filter((item) => item.completed)

  function addTask(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const content = newTask.trim()
    if (!content) return
    void onAct({ action: 'add', name: list.name, item: content }).then((ok) => { if (ok) setNewTask('') })
  }

  function saveRename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const next = rename.trim()
    if (!next || next === list.name) { setRenaming(false); return }
    void onAct({ action: 'rename', name: list.name, newName: next }).then((ok) => { if (ok) setRenaming(false) })
  }

  function removeList(): void {
    if (window.confirm(`Delete “${list.name}” and its tasks?`)) void onAct({ action: 'delete', name: list.name })
  }

  return <Shell
    notice={notice}
    onDismiss={onDismiss}
    head={<div className="tasklist-detail-head">
      <button className="settings-back" type="button" onClick={onBack}><Icon name="arrow-left" /><span>Task lists</span></button>
      <div className="tasklist-detail-title">
        <div>
          <h2 className="tasklist-detail-heading">{list.name}</h2>
          <p>{list.items.length === 0 ? 'No tasks yet' : `${todo.length} open · ${completed.length} completed`}</p>
        </div>
        <div className="tasklist-actions">
          <button className="button" type="button" onClick={() => { setRename(list.name); setRenaming(true) }}><Icon name="edit" size={14} /> Rename</button>
          <button className="button danger" type="button" disabled={saving} onClick={removeList}><Icon name="trash" size={14} /> Delete</button>
        </div>
      </div>
    </div>}
  >
    {renaming && <form className="tasklist-rename" onSubmit={saveRename}>
      <Field label="List name"><input value={rename} onChange={(event) => setRename(event.target.value)} maxLength={80} /></Field>
      <div className="save-actions">
        <button className="button" type="button" onClick={() => setRenaming(false)}>Cancel</button>
        <button className="button primary" type="submit" disabled={saving || !rename.trim()}>Save name</button>
      </div>
    </form>}
    <form className="tasklist-add" onSubmit={addTask}>
      <input className="tasklist-input" aria-label="Add a task" placeholder="Add something to this list…" value={newTask} onChange={(event) => setNewTask(event.target.value)} maxLength={300} />
      <button className="button primary" type="submit" disabled={saving || !newTask.trim()}><Icon name="plus" size={15} /> Add task</button>
    </form>
    {list.items.length === 0
      ? <p className="list-empty">This list is ready when you are. Add a task above, or ask Milo to remember one for you.</p>
      : <div className="tasklist-groups">
        {todo.length > 0 && <section className="tasklist-group">
          <h3 className="section-label">To do <span>{todo.length}</span></h3>
          {todo.map((item) => <TaskRow
            key={item.id}
            item={item}
            saving={saving}
            onComplete={() => void onAct({ action: 'complete', name: list.name, itemId: item.id })}
            onRemove={() => void onAct({ action: 'remove', name: list.name, itemId: item.id })}
          />)}
        </section>}
        {completed.length > 0 && <section className="tasklist-group">
          <h3 className="section-label">Completed <span>{completed.length}</span></h3>
          {completed.map((item) => <TaskRow key={item.id} item={item} saving={saving} onRemove={() => void onAct({ action: 'remove', name: list.name, itemId: item.id })} />)}
        </section>}
      </div>}
  </Shell>
}

/** One task: the box that closes it, its own words, and the way to drop it. */
function TaskRow({ item, saving, onComplete, onRemove }: { item: TaskItem; saving: boolean; onComplete?(): void; onRemove(): void }) {
  return <div className={`tasklist-row ${item.completed ? 'completed' : ''}`}>
    <button className="tasklist-check" type="button" disabled={saving || item.completed} aria-label={item.completed ? 'Completed' : `Complete ${item.content}`} onClick={onComplete}>{item.completed && <Icon name="check" size={13} />}</button>
    <span className="tasklist-row-text">{item.content}</span>
    <button className="icon-button tasklist-row-remove" type="button" title="Remove task" aria-label={`Remove ${item.content}`} disabled={saving} onClick={onRemove}><Icon name="trash" size={14} /></button>
  </div>
}
