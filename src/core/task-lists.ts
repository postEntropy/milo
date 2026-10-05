import { randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { taskListsFile } from './config/paths.js'
import { todoMark } from './todos.js'
import { writePrivateFile } from '../util/fs.js'
import { errorMessage } from '../util/errors.js'
import { logWarn } from '../util/log.js'

export interface TaskListItem {
  id: string
  content: string
  completed: boolean
  createdAt: number
}

export interface TaskList {
  id: string
  name: string
  createdAt: number
  items: TaskListItem[]
}

const LOCK_STALE_MS = 10_000
const WRITE_LOCK_RETRIES = { retries: 15, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true }

function validList(value: unknown): value is TaskList {
  if (!value || typeof value !== 'object') return false
  const list = value as Partial<TaskList>
  return (
    typeof list.id === 'string' &&
    typeof list.name === 'string' &&
    typeof list.createdAt === 'number' &&
    Array.isArray(list.items) &&
    list.items.every((item) => {
      if (!item || typeof item !== 'object') return false
      const task = item as Partial<TaskListItem>
      return typeof task.id === 'string' && typeof task.content === 'string' && typeof task.completed === 'boolean' && typeof task.createdAt === 'number'
    })
  )
}

export function readTaskLists(): TaskList[] {
  try {
    const value: unknown = JSON.parse(readFileSync(taskListsFile(), 'utf8'))
    if (!Array.isArray(value) || value.some((entry) => !validList(entry))) {
      throw new Error('task-lists.json does not contain a valid task list collection.')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function withTaskLists<T>(change: (lists: TaskList[]) => { result: T; write?: boolean }): Promise<T> {
  const file = taskListsFile()
  mkdirSync(dirname(file), { recursive: true })
  const release = await lockfile.lock(file, {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: WRITE_LOCK_RETRIES,
    onCompromised: (error) => logWarn(`lost the lock on task-lists.json: ${errorMessage(error)}`),
  })
  try {
    const lists = readTaskLists()
    const outcome = change(lists)
    if (outcome.write) await writePrivateFile(file, `${JSON.stringify(lists, null, 2)}\n`)
    return outcome.result
  } finally {
    await release()
  }
}

function byName(lists: TaskList[], name: string): TaskList | undefined {
  const normalized = name.trim().toLocaleLowerCase()
  return lists.find((list) => list.name.toLocaleLowerCase() === normalized)
}

export type TaskListAction =
  | { action: 'list' }
  | { action: 'create'; name: string }
  | { action: 'show'; name: string }
  | { action: 'add'; name: string; item: string }
  | { action: 'complete' | 'remove'; name: string; itemId: string }
  | { action: 'delete'; name: string }
  | { action: 'rename'; name: string; newName: string }

export async function manageTaskLists(input: TaskListAction): Promise<string> {
  return withTaskLists((lists) => {
    if (input.action === 'list') {
      return { result: lists.length ? lists.map((list) => `${list.name} (${list.items.filter((item) => !item.completed).length} open)`).join('\n') : 'There are no task lists yet.' }
    }
    if (input.action === 'create') {
      const name = input.name.trim()
      if (!name) return { result: 'A list name cannot be empty.' }
      if (byName(lists, name)) return { result: `A list named "${name}" already exists.` }
      lists.push({ id: randomUUID(), name, createdAt: Date.now(), items: [] })
      return { result: `Created list "${name}".`, write: true }
    }
    const list = byName(lists, input.name)
    if (!list) return { result: lists.length ? `No list named "${input.name}". Available lists: ${lists.map((entry) => entry.name).join(', ')}.` : 'There are no task lists yet.' }
    if (input.action === 'delete') {
      const index = lists.indexOf(list)
      lists.splice(index, 1)
      return { result: `Deleted list "${list.name}".`, write: true }
    }
    if (input.action === 'show') {
      return { result: list.items.length ? list.items.map((item) => `${todoMark(item.completed ? 'completed' : 'pending')} [${item.id.slice(0, 8)}] ${item.content}`).join('\n') : `List "${list.name}" is empty.` }
    }
    if (input.action === 'add') {
      const content = input.item.trim()
      if (!content) return { result: 'A task cannot be empty.' }
      const item = { id: randomUUID(), content, completed: false, createdAt: Date.now() }
      list.items.push(item)
      return { result: `Added "${content}" to "${list.name}" [${item.id.slice(0, 8)}].`, write: true }
    }
    if (input.action === 'rename') {
      const newName = input.newName.trim()
      if (!newName) return { result: 'A list name cannot be empty.' }
      if (byName(lists, newName) && newName.toLocaleLowerCase() !== list.name.toLocaleLowerCase()) return { result: `A list named "${newName}" already exists.` }
      const oldName = list.name
      list.name = newName
      return { result: `Renamed "${oldName}" to "${newName}".`, write: true }
    }
    const index = list.items.findIndex((item) => item.id === input.itemId || item.id.startsWith(input.itemId))
    if (index < 0) return { result: `No task "${input.itemId}" in "${list.name}".` }
    const [item] = list.items.splice(index, 1)
    if (input.action === 'complete') {
      item.completed = true
      list.items.splice(index, 0, item)
      return { result: `Completed "${item.content}" in "${list.name}".`, write: true }
    }
    return { result: `Removed "${item.content}" from "${list.name}".`, write: true }
  })
}
