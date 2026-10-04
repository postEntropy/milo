import { z } from 'zod'
import { manageTaskLists, type TaskListAction } from '../task-lists.js'
import type { Tool } from './types.js'

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('create'), name: z.string() }),
  z.object({ action: z.literal('show'), name: z.string() }),
  z.object({ action: z.literal('add'), name: z.string(), item: z.string() }),
  z.object({ action: z.literal('complete'), name: z.string(), itemId: z.string() }),
  z.object({ action: z.literal('remove'), name: z.string(), itemId: z.string() }),
  z.object({ action: z.literal('delete'), name: z.string() }),
  z.object({ action: z.literal('rename'), name: z.string(), newName: z.string() }),
])

export type TaskListsArgs = z.infer<typeof schema>

export const taskListsTool: Tool<TaskListsArgs> = {
  name: 'task_lists',
  description: 'Manage persistent named task lists shared across all Milo sessions. Use list to identify available names; always specify the exact list name for show, add, complete, remove, rename, or delete. If no exact list matches or the request could refer to multiple lists, ask the person which list they mean. Create named lists when asked. For each task use its displayed ID when completing or removing it. This is for the person’s ongoing task lists; use todo only for the temporary progress checklist of the current multi-step task.',
  schema,
  internal: true,
  async execute(args) {
    try {
      return { content: await manageTaskLists(args as TaskListAction) }
    } catch (error) {
      return { content: `Could not update task lists: ${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  },
}
