import { mkdirSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, parse } from 'node:path'
import { errorMessage } from '../util/errors.js'
import { resolveToolPath } from './tools/walk.js'

/** One folder inside the one being listed: the name it is shown by, and where it is. */
export interface FolderEntry {
  name: string
  path: string
}

/** A folder as a picker draws it: itself, the way up, and what is inside it. */
export interface FolderListing {
  /** The folder being listed, absolute. */
  path: string
  /** The folder's own name, for a heading. */
  name: string
  /** Where "up" goes. Absent at the filesystem root, so the control is not offered there. */
  parent?: string
  /** The folders inside it, by name. */
  folders: FolderEntry[]
  /** True when the list was cut at its ceiling, so a screen says so instead of pretending. */
  truncated: boolean
}

/**
 * A folder with thousands of children is not a list anybody reads. The listing is cut here
 * and the cut is said — the alternative is a screen that looks complete and is not.
 */
const MAX_FOLDERS = 200

/**
 * The folders inside one directory of the machine Milo runs on, for the picker a project is
 * chosen with. Only directories: a file is not somewhere a session can work.
 *
 * This is the **daemon's** filesystem and never the client's. The phone's own folders are not
 * where the work happens, so a picker that offered them would be choosing the wrong machine —
 * which is why this runs here and not through the platform's own file dialog.
 *
 * Absent or empty `target` starts at the home Milo runs as; `~` and a relative path are read
 * from there too. A folder that cannot be read is answered with the reason, not an empty list.
 */
export function browseFolders(target?: string, options: { cwd?: string } = {}): FolderListing {
  const asked = target?.trim()
  const path = asked ? resolveToolPath(options.cwd ?? homedir(), asked) : homedir()
  const entries = readFolder(path)

  const folders = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    // A symlink is kept only when it leads to a folder: one that leads nowhere is not
    // somewhere a session could work, and offering it would be offering a dead end.
    .filter((entry) => isFolder(entry.path))
    .sort((a, b) => a.name.localeCompare(b.name))

  const root = parse(path).root
  return {
    path,
    name: path === root ? root : basename(path),
    ...(path === root ? {} : { parent: dirname(path) }),
    folders: folders.slice(0, MAX_FOLDERS),
    truncated: folders.length > MAX_FOLDERS,
  }
}

/**
 * Why a name cannot be a folder's, or nothing when it can be: one segment, and neither
 * the folder it is in nor the one above it.
 */
export function folderNameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'a folder needs a name'
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return `${trimmed} is not a folder name.`
  }
  return undefined
}

/**
 * A folder made inside one of the daemon's own folders, for the picker a project is
 * chosen with — the folder a project needs may not exist yet. It answers with the listing
 * *inside* the new folder, so the person who made one to work in is already standing in it.
 */
export function createFolder(
  parent: string | undefined,
  name: string,
  options: { cwd?: string } = {},
): FolderListing {
  const problem = folderNameProblem(name)
  if (problem) throw new Error(problem)

  const folder = name.trim()
  const asked = parent?.trim()
  const path = asked ? resolveToolPath(options.cwd ?? homedir(), asked) : homedir()
  if (!isFolder(path)) throw new Error(`there is no folder at ${path}`)

  const target = join(path, folder)
  try {
    mkdirSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${target} already exists.`)
    throw new Error(`could not create ${target}: ${errorMessage(error)}`)
  }
  return browseFolders(target)
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** What is in a folder, or the reason it could not be read — the path is named in it. */
function readFolder(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch (error) {
    throw new Error(`could not read ${path}: ${errorMessage(error)}`)
  }
}
