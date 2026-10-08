import { statSync } from 'node:fs'
import { z } from 'zod'
import { displayPath, resolveToolPath } from './walk.js'
import type { Tool } from './types.js'

const schema = z.object({
  action: z
    .enum(['open', 'close'])
    .optional()
    .describe("'open' (the default) shows something in the panel; 'close' takes it down."),
  path: z
    .string()
    .optional()
    .describe(
      'The file to show, relative to the working directory (or absolute). Any type: HTML renders live, images inline, PDFs in a viewer, text and Markdown as prose.',
    ),
  browser: z
    .boolean()
    .optional()
    .describe('Show the browser you are driving, instead of a file. The person can click and type in it.'),
  title: z.string().optional().describe('A title for the panel header; the file name is used when absent.'),
})

export type PanelArgs = z.infer<typeof schema>

/**
 * The panel beside the web chat: the surface the model shows things on.
 *
 * It holds no effect of its own — nothing but the view a surface draws — so it
 * never asks, and its result carries the request for the web gateway to resolve
 * rather than only text. Only the web app has a panel, so the session keeps this
 * tool out of every other surface's catalog, the same way it withholds
 * `send_file` from the terminal.
 */
export const panelTool: Tool<PanelArgs> = {
  name: 'panel',
  description: [
    'Show something in the panel beside the chat, so the person sees it rather than reads it: a document or an HTML page you wrote, a screenshot, a PDF, any file — or the browser you are driving.',
    'Reach for it when what you made or found is the point: a report, a plan, a chart or an HTML page you wrote, a screenshot, a PDF, or a file someone asked to see. Show it and name it in one line ("here, look") instead of only pasting its contents into the reply.',
    'The panel opens itself, so nothing needs announcing.',
    'The panel holds one tab per thing: this opens a tab and puts it in front, or brings the tab already holding that same thing back to the front — it never takes away what is beside it. Your setup names the tabs that are open.',
    '`browser: true` shows the live browser you are driving, which the person can click and type in — use it to hand over a login, a 2FA code or a payment step you must not do yourself, and ask them to take it.',
    'Not on every turn: a passing mention, a link, or a short excerpt is prose, not a panel.',
    '`action: "close"` takes the whole panel down, every tab with it.',
  ].join(' '),
  schema,
  internal: true,
  async execute(args, ctx) {
    if (args.action === 'close') {
      return { content: 'The panel is closed.', panel: { close: true } }
    }
    const title = args.title?.trim() || undefined
    if (args.browser) {
      return {
        content: 'Showing the browser in the panel.',
        panel: { browser: true, ...(title ? { title } : {}) },
      }
    }
    if (!args.path?.trim()) {
      return {
        content:
          'The panel needs something to show: pass `path` for a file, `browser: true` for the browser you are driving, or `action: "close"` to take it down.',
        isError: true,
      }
    }
    const target = resolveToolPath(ctx.cwd, args.path)
    const stats = statSync(target, { throwIfNoEntry: false })
    if (!stats) {
      return { content: `No such file: ${displayPath(ctx.cwd, target)}`, isError: true }
    }
    if (!stats.isFile()) {
      return {
        content: `${displayPath(ctx.cwd, target)} is not a file — the panel shows a file or the browser, not a directory.`,
        isError: true,
      }
    }
    return {
      content: `Showing ${displayPath(ctx.cwd, target)} in the panel.`,
      panel: { path: target, ...(title ? { title } : {}) },
    }
  },
}
