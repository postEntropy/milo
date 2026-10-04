import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../lib/api.js'
import { Icon } from '../ui/Icons.js'

type TaskItem = { id: string; content: string; completed: boolean; createdAt: number }
type TaskList = { id: string; name: string; createdAt: number; items: TaskItem[] }
type Notice = { text: string; error: boolean }

export function TaskLists({ tick }: { tick: number }) {
  const [lists, setLists] = useState<TaskList[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newList, setNewList] = useState('')
  const [newTask, setNewTask] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [rename, setRename] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api<TaskList[]>('task-lists')
      setLists(next)
      setSelectedId((current) => current && next.some((list) => list.id === current) ? current : next[0]?.id ?? null)
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  // A chat turn may have changed a list through Milo; redraw its persisted state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is a change signal only
  useEffect(() => { void refresh() }, [tick, refresh])

  const selected = lists?.find((list) => list.id === selectedId) ?? null
  const openCount = useMemo(() => lists?.reduce((sum, list) => sum + list.items.filter((item) => !item.completed).length, 0) ?? 0, [lists])

  async function act(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true)
    setNotice(null)
    try {
      const result = await api<{ result: string; lists: TaskList[] }>('task-list-action', body)
      setLists(result.lists)
      setSelectedId((current) => current && result.lists.some((list) => list.id === current) ? current : result.lists[0]?.id ?? null)
      setNotice({ text: result.result, error: false })
      return true
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error), error: true })
      return false
    } finally {
      setSaving(false)
    }
  }

  function createList(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const name = newList.trim()
    if (!name) return
    void act({ action: 'create', name }).then((ok) => { if (ok) setNewList('') })
  }
  function addTask(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const item = newTask.trim()
    if (!item || !selected) return
    void act({ action: 'add', name: selected.name, item }).then((ok) => { if (ok) setNewTask('') })
  }
  function saveRename(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!selected || !rename.trim()) return
    void act({ action: 'rename', name: selected.name, newName: rename.trim() }).then((ok) => { if (ok) setRenaming(false) })
  }

  return <main className="settings-workspace tasklists-workspace">
    <div className="tasklists-inner">
      <header className="tasklists-heading">
        <div className="tasklists-heading-copy">
          <span className="tasklists-eyebrow">YOUR WORKSPACE</span>
          <h2>Task lists</h2>
          <p>Keep the things you and Milo are working on, together across sessions.</p>
        </div>
        {lists && lists.length > 0 && <div className="tasklists-total"><strong>{openCount}</strong><span>open tasks</span></div>}
      </header>
      {notice && <div className={`tasklists-notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}<button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><Icon name="x" size={15} /></button></div>}
      {lists === null ? notice?.error
        ? <div className="tasklists-loading tasklists-load-error"><p>Could not load your task lists.</p><button className="button" type="button" onClick={() => { setNotice(null); void refresh() }}>Try again</button></div>
        : <div className="tasklists-loading" role="status">Loading your task lists…</div>
        : lists.length === 0 ? <section className="tasklists-welcome">
          <div className="tasklists-welcome-art" aria-hidden="true"><span>✓</span><span>·</span><span>·</span></div>
          <h3>A little more room for what’s next.</h3>
          <p>Create a list for a project, an idea, or anything you want Milo to keep track of with you.</p>
          <form className="tasklists-create tasklists-create-first" onSubmit={createList}>
            <input aria-label="New list name" placeholder="Give your first list a name" value={newList} onChange={(event) => setNewList(event.target.value)} maxLength={80} />
            <button className="button primary" type="submit" disabled={saving || !newList.trim()}><Icon name="plus" size={15} /> Create list</button>
          </form>
        </section>
        : <div className="tasklists-layout">
          <aside className="tasklists-rail" aria-label="Your task lists">
            <div className="tasklists-rail-head"><span>YOUR LISTS</span><span>{lists.length}</span></div>
            <nav className="tasklists-nav">
              {lists.map((list) => {
                const remaining = list.items.filter((item) => !item.completed).length
                return <button key={list.id} type="button" className={`tasklists-nav-item ${selectedId === list.id ? 'active' : ''}`} onClick={() => { setSelectedId(list.id); setRenaming(false) }}>
                  <span className="tasklists-nav-mark"><Icon name="check" size={14} /></span>
                  <span className="tasklists-nav-name">{list.name}</span>
                  <span className="tasklists-nav-count">{remaining}</span>
                </button>
              })}
            </nav>
            <form className="tasklists-create" onSubmit={createList}>
              <input aria-label="New list name" placeholder="New list name" value={newList} onChange={(event) => setNewList(event.target.value)} maxLength={80} />
              <button type="submit" aria-label="Create list" title="Create list" disabled={saving || !newList.trim()}><Icon name="plus" size={17} /></button>
            </form>
            <p className="tasklists-rail-foot">Milo can update these from any session.</p>
          </aside>
          {selected && <section className="tasklist-detail" aria-labelledby="tasklist-title">
            <div className="tasklist-detail-head">
              <div className="tasklist-title-wrap">
                <span className="tasklist-title-mark"><Icon name="check" size={17} /></span>
                <div>{renaming
                  ? <form className="tasklist-rename" onSubmit={saveRename}><input aria-label="List name" value={rename} onChange={(event) => setRename(event.target.value)} /><button className="icon-button" type="submit" title="Save name" aria-label="Save name"><Icon name="check" size={16} /></button><button className="icon-button" type="button" title="Cancel" aria-label="Cancel" onClick={() => setRenaming(false)}><Icon name="x" size={16} /></button></form>
                  : <><h3 id="tasklist-title">{selected.name}</h3><p>{selected.items.length === 0 ? 'A fresh start' : `${selected.items.length} task${selected.items.length === 1 ? '' : 's'} · ${selected.items.filter((item) => item.completed).length} completed`}</p></>}
                </div>
              </div>
              <div className="tasklist-actions">
                <button className="tasklist-action" type="button" title="Rename list" onClick={() => { setRename(selected.name); setRenaming(true) }}><Icon name="edit" size={15} /><span>Rename</span></button>
                <button className="tasklist-action danger" type="button" title="Delete list" onClick={() => { if (window.confirm(`Delete “${selected.name}” and its tasks?`)) void act({ action: 'delete', name: selected.name }) }}><Icon name="trash" size={15} /><span>Delete</span></button>
              </div>
            </div>
            <form className="tasklist-add" onSubmit={addTask}>
              <span className="tasklist-add-plus"><Icon name="plus" size={17} /></span>
              <input aria-label="Add a task" placeholder="Add something to this list…" value={newTask} onChange={(event) => setNewTask(event.target.value)} maxLength={300} />
              <button className="button primary" type="submit" disabled={saving || !newTask.trim()}>Add task</button>
            </form>
            {selected.items.length === 0 ? <div className="tasklist-empty"><span className="tasklist-empty-check"><Icon name="check" size={18} /></span><h4>This list is ready when you are</h4><p>Add a task here or ask Milo to remember one for you.</p></div>
              : <div className="tasklist-items">
                {selected.items.some((item) => !item.completed) && <h4 className="tasklist-group-label">TO DO <span>{selected.items.filter((item) => !item.completed).length}</span></h4>}
                {selected.items.filter((item) => !item.completed).map((item) => <TaskRow key={item.id} item={item} saving={saving} onComplete={() => void act({ action: 'complete', name: selected.name, itemId: item.id })} onRemove={() => void act({ action: 'remove', name: selected.name, itemId: item.id })} />)}
                {selected.items.some((item) => item.completed) && <><h4 className="tasklist-group-label completed-label">COMPLETED <span>{selected.items.filter((item) => item.completed).length}</span></h4>{selected.items.filter((item) => item.completed).map((item) => <TaskRow key={item.id} item={item} saving={saving} onComplete={() => {}} onRemove={() => void act({ action: 'remove', name: selected.name, itemId: item.id })} />)}</>}
              </div>}
          </section>}
        </div>}
    </div>
  </main>
}

function TaskRow({ item, saving, onComplete, onRemove }: { item: TaskItem; saving: boolean; onComplete(): void; onRemove(): void }) {
  return <article className={`tasklist-row ${item.completed ? 'completed' : ''}`}>
    <button className="tasklist-check" type="button" disabled={saving || item.completed} aria-label={item.completed ? 'Completed' : `Complete ${item.content}`} onClick={onComplete}>{item.completed && <Icon name="check" size={13} />}</button>
    <span className="tasklist-row-text">{item.content}</span>
    <button className="tasklist-row-remove" type="button" title="Remove task" aria-label={`Remove ${item.content}`} disabled={saving} onClick={onRemove}><Icon name="trash" size={14} /></button>
  </article>
}
