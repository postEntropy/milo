import { z } from 'zod'
import { formatTodos, type TodoItem } from '../todos.js'
import type { Tool } from './types.js'

const schema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().describe('One step, said in a few words.'),
        status: z.enum(['pending', 'in_progress', 'completed']).describe('Where the step stands.'),
      }),
    )
    .describe('The whole plan, every call: the steps and where each one stands.'),
})

export type TodoArgs = z.infer<typeof schema>

/**
 * The plan the person watches during a long turn. It holds no effect of its own
 * — nothing but the list drawn on the surfaces — so it never asks, and its result
 * carries the items for the loop to turn into an event rather than only text.
 */
export const todoTool: Tool<TodoArgs> = {
  name: 'todo',
  description:
    'Keep the plan for a multi-step task: a short checklist shown to the person while you work. Call it with the whole list whenever it changes — exactly one step in_progress at a time, and each marked completed the moment it is done, not in a batch at the end. Skip it for a task of one or two steps.',
  schema,
  readOnly: false,
  internal: true,
  async execute(args) {
    const items: TodoItem[] = args.todos.map((todo) => ({ content: todo.content.trim(), status: todo.status }))
    // An empty list is no plan at all, so nothing is drawn and no event is sent.
    if (items.length === 0) return { content: 'The plan is now empty.' }
    return { content: formatTodos(items), todos: items }
  },
}
