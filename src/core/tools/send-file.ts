import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import type { Tool } from './types.js'
import { resolveToolPath } from './walk.js'

const schema = z.object({
  path: z.string().describe('The file to send, relative to the working directory (or absolute).'),
  caption: z.string().optional().describe('An optional line to show with the file.'),
})

export type SendFileArgs = z.infer<typeof schema>

export const sendFileTool: Tool<SendFileArgs> = {
  name: 'send_file',
  description:
    "Send a file on this machine to the chat this turn delivers to — the target of the routine this turn is running. A picture (png, jpeg, gif, webp) arrives as a picture; anything else arrives as a document. Use it to deliver a screenshot, a report, or any file you have made or named: take the screenshot with shell_command (e.g. `grim` on Wayland, `scrot` on X11), then send the file it wrote. It is unavailable in a chat someone is sitting at, where there is no out-of-band delivery to reach.",
  schema,
  async execute(args, ctx) {
    if (!ctx.sendFile) {
      return {
        content: 'This turn has no chat to send a file to — send_file only works in a routine.',
        isError: true,
      }
    }
    try {
      const file = await ctx.sendFile({ path: resolveToolPath(ctx.cwd, args.path), caption: args.caption })
      return { content: `Sent ${file.name} to the chat.` }
    } catch (error) {
      return { content: `Could not send ${args.path}: ${errorMessage(error)}`, isError: true }
    }
  },
}
