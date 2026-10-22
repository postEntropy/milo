import { mkdir, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { changeReported, fileChange, type FileChange } from '../change.js'
import { errorMessage } from '../../util/errors.js'
import { writeFileAtomic } from '../../util/fs.js'
import type { Tool } from './types.js'
import { displayPath, resolveWritePath } from './walk.js'

/**
 * A change across files, in one call and one approval.
 *
 * The format is strict on purpose: context lines must match the file exactly, and
 * every file and hunk is checked before anything is written. A patch that would
 * half-apply is refused with the file and hunk named, because the alternative —
 * writing the hunks that did match — leaves a tree nobody asked for and no clear
 * way back.
 */

const schema = z.object({
  patch: z
    .string()
    .describe(
      'The patch, in the strict format: "*** Begin Patch", then "*** Update File: path" with "@@" hunks (" " context, "-" removed, "+" added), "*** Add File: path" with "+" lines, or "*** Delete File: path", then "*** End Patch".',
    ),
})

export type ApplyPatchArgs = z.infer<typeof schema>

type PatchOperation =
  | { kind: 'update'; path: string; hunks: Hunk[] }
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }

interface Hunk {
  /** Lines as the patch wrote them, each keeping its leading space, `+` or `-`. */
  lines: string[]
}

type ParseResult =
  | { ok: true; operations: PatchOperation[] }
  | { ok: false; error: string }

/** Parses a patch without touching the filesystem, so a malformed one costs nothing. */
export function parsePatch(input: string): ParseResult {
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  // The markers are the outside of the patch; blank lines around them are not
  // content, and a code fence often leaves one.
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()

  if (lines[0]?.trim() !== '*** Begin Patch') {
    return { ok: false, error: 'the patch must start with "*** Begin Patch".' }
  }
  if (lines[lines.length - 1]?.trim() !== '*** End Patch') {
    return { ok: false, error: 'the patch must end with "*** End Patch".' }
  }

  const operations: PatchOperation[] = []
  // The markers are already off both ends, so the body starts at its own zero.
  let index = 0
  const body = lines.slice(1, -1)

  while (index < body.length) {
    const line = body[index]!
    if (line.trim() === '') {
      index += 1
      continue
    }

    const update = /^\*\*\* Update File:\s*(.+)$/.exec(line)
    const add = /^\*\*\* Add File:\s*(.+)$/.exec(line)
    const remove = /^\*\*\* Delete File:\s*(.+)$/.exec(line)

    if (update) {
      const parsed = parseHunks(body, index + 1)
      if (!parsed.ok) return { ok: false, error: parsed.error }
      if (parsed.hunks.length === 0) {
        return { ok: false, error: `${update[1]!.trim()}: an update needs at least one "@@" hunk.` }
      }
      operations.push({ kind: 'update', path: update[1]!.trim(), hunks: parsed.hunks })
      index = parsed.next
      continue
    }

    if (add) {
      const collected: string[] = []
      let cursor = index + 1
      while (cursor < body.length && !body[cursor]!.startsWith('*** ')) {
        const content = body[cursor]!
        if (content !== '' && !content.startsWith('+')) {
          return {
            ok: false,
            error: `${add[1]!.trim()}: an added file takes lines that start with "+", found "${content}".`,
          }
        }
        if (content.startsWith('+')) collected.push(content.slice(1))
        cursor += 1
      }
      operations.push({ kind: 'add', path: add[1]!.trim(), lines: collected })
      index = cursor
      continue
    }

    if (remove) {
      const name = remove[1]!.trim()
      let cursor = index + 1
      while (cursor < body.length && body[cursor]!.trim() === '') cursor += 1
      if (cursor < body.length && !body[cursor]!.startsWith('*** ')) {
        return { ok: false, error: `${name}: a deleted file takes no content.` }
      }
      operations.push({ kind: 'delete', path: name })
      index = cursor
      continue
    }

    return { ok: false, error: `unexpected line "${line}" — expected a "*** … File:" header.` }
  }

  if (operations.length === 0) return { ok: false, error: 'the patch changes nothing.' }
  return { ok: true, operations }
}

function parseHunks(
  body: string[],
  start: number,
): { ok: true; hunks: Hunk[]; next: number } | { ok: false; error: string } {
  const hunks: Hunk[] = []
  let index = start

  while (index < body.length && !body[index]!.startsWith('*** ')) {
    const line = body[index]!
    if (line.trim() === '') {
      index += 1
      continue
    }
    if (!line.startsWith('@@')) {
      return { ok: false, error: `a hunk starts with "@@", found "${line}".` }
    }
    const hunk: Hunk = { lines: [] }
    index += 1
    while (index < body.length && !body[index]!.startsWith('@@') && !body[index]!.startsWith('*** ')) {
      const content = body[index]!
      // An empty line is an empty context line: the whitespace in front of it is
      // invisible in a patch, and requiring it would refuse every file whose
      // context touches a blank line.
      if (content === '') hunk.lines.push(' ')
      else if (content.startsWith(' ') || content.startsWith('+') || content.startsWith('-')) {
        hunk.lines.push(content)
      } else {
        return { ok: false, error: `a hunk line starts with " ", "+" or "-", found "${content}".` }
      }
      index += 1
    }
    if (!hunk.lines.some((entry) => entry.startsWith(' ') || entry.startsWith('-'))) {
      return { ok: false, error: 'a hunk needs at least one context or removed line to anchor it.' }
    }
    hunks.push(hunk)
  }

  return { ok: true, hunks, next: index }
}

/** The targets a patch names, for permissions and the rules that protect paths. */
export function patchTargets(input: string): string[] {
  const targets: string[] = []
  for (const match of input.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) {
    const name = match[1]?.trim()
    if (name) targets.push(name)
  }
  return targets
}

export const applyPatchTool: Tool<ApplyPatchArgs> = {
  name: 'apply_patch',
  description:
    'Change several files in one call, as one approval. The patch is strict: every context line must match the file exactly, every file and hunk is checked before anything is written, and a hunk that does not fit refuses the whole patch. Use it when one change spans files; for one small replacement, edit_file is simpler.',
  schema,
  readOnly: false,
  async execute(args, ctx) {
    const parsed = parsePatch(args.patch)
    if (!parsed.ok) return { content: `The patch was not applied: ${parsed.error}`, isError: true }

    const prepared: Prepared[] = []
    // Everything is read and checked first. Nothing is written until every file in
    // the patch is known to apply — a partial patch is worse than none.
    for (const operation of parsed.operations) {
      const resolved = resolveWritePath(ctx.cwd, operation.path, ctx.confineTo)
      if (!resolved.ok) {
        return { content: `The patch was not applied: ${resolved.error}`, isError: true }
      }
      const target = resolved.path
      const shown = displayPath(ctx.cwd, target)

      if (operation.kind === 'add') {
        const existing = await stat(target).catch(() => null)
        if (existing) {
          return { content: `The patch was not applied: ${shown} already exists.`, isError: true }
        }
        prepared.push({
          kind: 'add',
          target,
          shown,
          content: operation.lines.length > 0 ? `${operation.lines.join('\n')}\n` : '',
        })
        continue
      }

      if (operation.kind === 'delete') {
        const existing = await stat(target).catch(() => null)
        if (!existing) {
          return { content: `The patch was not applied: ${shown} does not exist.`, isError: true }
        }
        if (existing.isDirectory()) {
          return { content: `The patch was not applied: ${shown} is a directory.`, isError: true }
        }
        // Read for the change only: the deletion itself needs the name, not the
        // contents. A file that cannot be read is still deleted, and then says
        // nothing about what it held.
        const content = await readFile(target, 'utf8').catch(() => undefined)
        prepared.push({ kind: 'delete', target, shown, ...(content !== undefined ? { before: content } : {}) })
        continue
      }

      let content: string
      try {
        content = await readFile(target, 'utf8')
      } catch (error) {
        return { content: `The patch was not applied: could not read ${shown}: ${errorMessage(error)}`, isError: true }
      }
      const applied = applyHunks(content, operation.hunks)
      if (!applied.ok) {
        return { content: `The patch was not applied: ${shown}: ${applied.error}`, isError: true }
      }
      prepared.push({
        kind: 'update',
        target,
        shown,
        content: applied.content,
        before: content,
        hunks: operation.hunks.length,
      })
    }

    const report: string[] = []
    const changes: FileChange[] = []
    for (const item of prepared) {
      try {
        if (item.kind === 'delete') {
          await unlink(item.target)
          report.push(`- ${item.shown}: deleted`)
          if (item.before !== undefined) {
            const change = fileChange(item.shown, item.before, null)
            if (changeReported(change)) changes.push(change)
          }
          continue
        }
        await mkdir(path.dirname(item.target), { recursive: true })
        await writeFileAtomic(item.target, item.content!)
        report.push(
          item.kind === 'add'
            ? `- ${item.shown}: added, ${countLines(item.content!)} line(s)`
            : `- ${item.shown}: ${item.hunks} hunk(s) applied`,
        )
        const change = fileChange(item.shown, item.kind === 'add' ? null : item.before, item.content!)
        if (changeReported(change)) changes.push(change)
      } catch (error) {
        // A write that fails halfway leaves the files already written; say which
        // one failed rather than reporting the patch as a whole.
        return {
          content: `The patch failed while writing ${item.shown}: ${errorMessage(error)}${report.length > 0 ? `\nAlready applied:\n${report.join('\n')}` : ''}`,
          isError: true,
        }
      }
    }

    return {
      content: `Patch applied:\n${report.join('\n')}`,
      ...(changes.length > 0 ? { change: changes } : {}),
    }
  },
}

type Prepared =
  | { kind: 'update'; target: string; shown: string; content: string; before: string; hunks: number }
  | { kind: 'add'; target: string; shown: string; content: string }
  | { kind: 'delete'; target: string; shown: string; before?: string }

/**
 * Applies the hunks to one file. Context and removed lines are matched as a
 * contiguous run, exactly, from the end of the previous hunk onwards; a run that
 * matches nothing or matches more than once is refused, and the hunk is named.
 */
function applyHunks(
  content: string,
  hunks: Hunk[],
): { ok: true; content: string } | { ok: false; error: string } {
  const lines = content.split('\n')
  let searchFrom = 0

  for (const [number, hunk] of hunks.entries()) {
    const oldLines = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1))
    const newLines = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('+'))
      .map((line) => line.slice(1))

    const matches: number[] = []
    for (let index = searchFrom; index + oldLines.length <= lines.length; index += 1) {
      if (oldLines.every((line, offset) => lines[index + offset] === line)) matches.push(index)
    }

    if (matches.length === 0) {
      return { ok: false, error: `hunk ${number + 1} does not match the file. Read it and make the context exact.` }
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `hunk ${number + 1} matches ${matches.length} places — include more context to make it unique.`,
      }
    }

    const at = matches[0]!
    lines.splice(at, oldLines.length, ...newLines)
    searchFrom = at + newLines.length
  }

  return { ok: true, content: lines.join('\n') }
}

function countLines(content: string): number {
  if (content === '') return 0
  return content.replace(/\n$/, '').split('\n').length
}
