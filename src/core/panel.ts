/**
 * The panel: a surface beside the web chat where a document, a canvas, a file or
 * the browser is shown. It is the model's own display state — set with the
 * `panel` tool — carried as a small request rather than as content, so a
 * document's bytes ride the transcript as a path and never as prefill.
 */

/**
 * Where the panel should point.
 *
 * A request, not the content: the surface that can draw a panel resolves it —
 * reads the file, registers it, attaches to the browser — so the transcript keeps
 * only this small pointer and the file's bytes stay out of the model's context.
 */
export interface PanelRequest {
  /** A file to show. Resolved to an absolute path by the tool that made it. */
  path?: string
  /** Show the browser Milo is driving, instead of a file. */
  browser?: boolean
  /** A title for the panel's header; the file's name is used when absent. */
  title?: string
  /** Take the panel down. */
  close?: boolean
}
