import { describe, expect, it } from 'vitest'
import type { Message } from '../src/core/providers/types.js'
import { formatTodos, todoMark, todosFromArgs, type TodoItem } from '../src/core/todos.js'
import { todoTool } from '../src/core/tools/todo.js'
import { transcriptOf } from '../src/gateways/web/transcript.js'

const ctx = { cwd: process.cwd(), signal: new AbortController().signal }

describe('todo', () => {
  it('marks each status with its own glyph', () => {
    expect(todoMark('pending')).toBe('☐')
    expect(todoMark('in_progress')).toBe('▸')
    expect(todoMark('completed')).toBe('✔')
  })

  it('draws the checklist with one step per line', () => {
    const items: TodoItem[] = [
      { content: 'Read the spec', status: 'completed' },
      { content: 'Write the parser', status: 'in_progress' },
      { content: 'Add tests', status: 'pending' },
    ]
    expect(formatTodos(items)).toBe('✔ Read the spec\n▸ Write the parser\n☐ Add tests')
  })

  it('returns the plan as both text and items, for the surfaces', async () => {
    const result = await todoTool.execute(
      {
        todos: [
          { content: 'Step one', status: 'in_progress' },
          { content: 'Step two', status: 'pending' },
        ],
      },
      ctx,
    )
    expect(result.content).toBe('▸ Step one\n☐ Step two')
    expect(result.todos).toEqual([
      { content: 'Step one', status: 'in_progress' },
      { content: 'Step two', status: 'pending' },
    ])
  })

  it('never asks: it only changes what is drawn', () => {
    expect(todoTool.internal).toBe(true)
    expect(todoTool.readOnly).toBe(false)
  })

  it('drops a step that is not the shape it should be', () => {
    const items = todosFromArgs({
      todos: [
        { content: 'ok', status: 'pending' },
        { content: '   ', status: 'pending' },
        { content: 'x', status: 'later' },
        'nope',
      ],
    })
    expect(items).toEqual([{ content: 'ok', status: 'pending' }])
  })

  it('reads nothing out of arguments that hold no plan', () => {
    expect(todosFromArgs({ path: 'a.txt' })).toEqual([])
    expect(todosFromArgs(null)).toEqual([])
  })
})

describe('transcriptOf — the plan survives a reload', () => {
  it('reads the plan back out of a todo call in a stored turn', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'on it' },
          { type: 'tool-call', id: 'c1', name: 'todo', args: { todos: [{ content: 'Step', status: 'in_progress' }] } },
        ],
      },
      { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'todo', content: '▸ Step' }] },
    ]
    const transcript = transcriptOf(messages, (file) => ({
      id: file.path,
      name: file.name,
      mimeType: file.mimeType,
      size: 0,
      image: false,
    }))
    const assistant = transcript.find((message) => message.role === 'assistant')
    expect(assistant?.todos).toEqual([{ content: 'Step', status: 'in_progress' }])
    // The plan call is not drawn as a tool line beside its own checklist.
    expect(assistant?.tools).toBeUndefined()
  })
})
