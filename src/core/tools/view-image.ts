import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'
import { errorMessage } from '../../util/errors.js'
import { mimeFor } from '../outgoing.js'
import type { Tool } from './types.js'
import { displayPath, resolveToolPath } from './walk.js'

const schema = z.object({
  path: z.string().describe('The picture to look at, relative to the working directory (or absolute).'),
})

export type ViewImageArgs = z.infer<typeof schema>

export const viewImageTool: Tool<ViewImageArgs> = {
  name: 'view_image',
  description:
    "Look at a picture on this machine yourself — a screenshot, a photo, a diagram — and answer about what is in it. The picture comes back to you, not to the person: `send_file` is what puts one in the chat. A png or a jpeg; take a screenshot with `shell_command` (`grim` on Wayland, `scrot` on X11) and look at the file it wrote, rather than serving it over HTTP for the browser.",
  schema,
  readOnly: true,
  concurrent: true,
  async execute(args, ctx) {
    const target = resolveToolPath(ctx.cwd, args.path)
    const shown = displayPath(ctx.cwd, target)

    try {
      const info = await stat(target)
      if (info.isDirectory()) {
        return { content: `${shown} is a directory, not a picture.`, isError: true }
      }
      const mimeType = mimeFor(target)
      if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') {
        return {
          content: `${shown} is ${mimeType}; a picture has to be a png or a jpeg for you to look at it.`,
          isError: true,
        }
      }
      const bytes = await readFile(target)
      return {
        content: `Looking at ${shown}.`,
        images: [{ mimeType, data: bytes.toString('base64') }],
      }
    } catch (error) {
      return { content: `Could not look at ${shown}: ${errorMessage(error)}`, isError: true }
    }
  },
}
