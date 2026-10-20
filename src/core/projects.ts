import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { errorMessage } from '../util/errors.js'
import { writePrivateFile } from '../util/fs.js'
import { logWarn } from '../util/log.js'
import { projectsFile } from './config/paths.js'
import { generateNickname } from './sessions/nickname.js'
import { resolveToolPath } from './tools/walk.js'

/**
 * A folder the work happens in, named. The session is what carries the work —
 * a project is only where it happens, and the one thing a session with a project
 * gets that a session without one does not is a directory of its own: its tools,
 * its subagent and its prompt all read from there.
 *
 * Kept deliberately small. A name and a folder, and the id the list knows it by;
 * everything else a person might want to pin on a project is a decision to make
 * when something actually needs it.
 */
export interface ProjectCheck {
  name: string
  command: string
}

export interface Project {
  /** `calm-otter-7`, the shape a session and a routine are known by too. */
  id: string
  /** What a person calls it. The folder's own name unless one was given. */
  name: string
  /** The folder, absolute — so two entries cannot name the same one by accident. */
  path: string
  createdAt: number
  /**
   * The checks this project runs after a turn that wrote, when the verification
   * gate is on. Absent means "discover them from the folder"; present is the
   * person's own list, and the only thing run.
   */
  checks?: ProjectCheck[]
}

/** What it takes to register one, before the store gives it an id and a timestamp. */
export interface NewProject {
  /** Absent takes the folder's own name. */
  name?: string
  /**
   * The folder. `~` and a relative path are read from where the command was run,
   * and what is kept is the absolute one.
   */
  path: string
}

/**
 * A ceiling on the list, like `MAX_ROUTINES`: a list a person keeps by hand does
 * not run away, and a model that got creative about folders cannot grow the file
 * without bound.
 */
export const MAX_PROJECTS = 50

/** What changing the list answered: the project, or why the change was refused. */
export type ProjectOutcome = { ok: true; project: Project } | { ok: false; error: string }

/**
 * Whether a registered folder can still be worked in, and why not when it cannot.
 * A discriminated answer rather than `Project | undefined`, because "there is no
 * such project" and "its folder is gone" are two different things to say to the
 * person, and a session that cannot work where it was told to must say so rather
 * than quietly work somewhere else.
 */
export type ProjectPlacement =
  | { ok: true; project: Project }
  /** The record that was found, when one was: its name is what a bar says the session is in. */
  | { ok: false; id: string; error: string; project?: Project }

/**
 * How the core finds a project's folder. Injected into the runtime the way the
 * stores are, so a test can answer without a projects file existing.
 */
export type ProjectLookup = (id: string) => ProjectPlacement

/**
 * The file as projects. Absent or empty is an empty list; anything present that
 * is not a list of projects throws, because that is a file to report rather than
 * one to read as nothing — reading it as nothing is what let the next write
 * erase it.
 */
function readProjectsStrict(): Project[] {
  const file = projectsFile()
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8').trim()
  if (text === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`projects.json is not valid JSON: ${errorMessage(error)}`)
  }
  if (!Array.isArray(parsed)) throw new Error('projects.json does not hold a list.')
  return parsed.filter(isProject).map((project) => ({
    ...project,
    name: project.name.trim() || basename(project.path),
    createdAt: typeof project.createdAt === 'number' ? project.createdAt : Date.now(),
  }))
}

/**
 * The project list for a surface that only reads it. A file someone left mid-edit
 * must not take the daemon down, so the reason is said out loud and an empty list
 * is answered — but a *write* reads strictly below, so this tolerant reading is
 * never the basis of an overwrite.
 */
export function readProjects(): Project[] {
  try {
    return readProjectsStrict()
  } catch (error) {
    logWarn(`could not read projects.json: ${errorMessage(error)}`)
    return []
  }
}

/**
 * How long a lock is believed after the process holding it stops refreshing it.
 * A read-modify-write holds it for milliseconds; the holder that dies is the one
 * whose lock this breaks.
 */
const LOCK_STALE_MS = 10_000
/** Write windows are short and rare: waiting is cheaper than losing a change. */
const WRITE_LOCK_RETRIES = { retries: 15, factor: 1.5, minTimeout: 20, maxTimeout: 250, randomize: true }

/**
 * Takes the file's lock, so a read-modify-write is one step across processes.
 * `projects.json` has two writers in different processes — the daemon serving the
 * Work screen while `milo projects add` adds one — and each rewrites the whole
 * list from the copy it read, so without the lock the slower writer's copy wins
 * and the other change is gone.
 */
async function lockProjects(): Promise<() => Promise<void>> {
  // Only the directory has to exist: `realpath: false` locks the path as given,
  // and the lock itself is a directory created beside the file.
  mkdirSync(dirname(projectsFile()), { recursive: true })
  return lockfile.lock(projectsFile(), {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: WRITE_LOCK_RETRIES,
    // A late write is not a reason to take the process down.
    onCompromised: (error) => logWarn(`lost the lock on projects.json: ${errorMessage(error)}`),
  })
}

function serialize(projects: Project[]): string {
  return `${JSON.stringify(projects, null, 2)}\n`
}

/** Replaces the whole list, under the lock and through a rename, like every write here. */
export async function writeProjects(projects: Project[]): Promise<void> {
  const release = await lockProjects()
  try {
    await writePrivateFile(projectsFile(), serialize(projects))
  } finally {
    await release()
  }
}

export function findProject(id: string): Project | undefined {
  return readProjects().find((project) => project.id === id)
}

/**
 * A project named from a command line: its id, its name, or the folder it points
 * at. A reference is one of those, and the folder is resolved from where the
 * command was run, so `--project .` means the project whose folder is here.
 */
export function resolveProjectRef(ref: string, base: string = process.cwd()): Project | undefined {
  const trimmed = ref.trim()
  if (!trimmed) return undefined
  const projects = readProjects()
  const named = projects.find((project) => project.id === trimmed || project.name === trimmed)
  if (named) return named
  const folder = resolveToolPath(base, trimmed)
  return projects.find((project) => project.path === folder)
}

/**
 * The install's projects as id → name, for a list that draws sessions and wants to
 * say which project each one is in. Read once for the whole listing rather than
 * once per session.
 */
export function projectNames(): Map<string, string> {
  return new Map(readProjects().map((project) => [project.id, project.name]))
}

/**
 * Where a session carrying this project runs — or why it cannot run there. The
 * folder is checked at the moment it is wanted, so a project whose directory was
 * deleted, unmounted or moved answers with that rather than handing a session a
 * path that no longer is one.
 */
export function placeProject(id: string): ProjectPlacement {
  const project = findProject(id)
  if (!project) {
    return { ok: false, id, error: `the project ${id} is not in the list any more` }
  }
  const reason = missingReason(project)
  if (reason) return { ok: false, id, project, error: reason }
  return { ok: true, project }
}

/**
 * A session's project as a surface's own bar reads it: the project, and why it cannot be
 * worked in when it cannot. Nothing when the record is gone altogether — a session bound to a
 * project that is not in the list any more is a session with no project to be in. The same
 * shape the Work screen's list draws, so a surface reads one project type.
 */
export function placedProject(placement: ProjectPlacement): ProjectView | undefined {
  if (!placement.project) return undefined
  return placement.ok ? { ...placement.project } : { ...placement.project, error: placement.error }
}

/** A project as a screen draws it: itself, and why it cannot be worked in when it cannot. */
export interface ProjectView extends Project {
  /** Set when the folder is not there any more, so a list can say it rather than draw a dead entry. */
  error?: string
}

/**
 * The whole list, each entry already told whether its folder is still there — one
 * read of the file and one look at each folder, for a screen that draws them all.
 */
export function projectViews(): ProjectView[] {
  return readProjects().map((project) => {
    const error = missingReason(project)
    return error ? { ...project, error } : { ...project }
  })
}

/** What a project's place in the list is read from: one session's folder, and when it last moved. */
export interface ProjectUse {
  /** The project the session works in; absent for a session with none. */
  project?: string
  updatedAt: number
}

/**
 * The list in the order a person reaches for it: the folder worked in most recently
 * first. A project's recency is its newest session's `updatedAt`, not the moment it
 * was registered — the list is a workbench, and what was touched last is what is
 * wanted next. A project no session ever ran in has no recency and keeps its place
 * in the file, under the ones that do.
 */
export function byRecentUse<T extends Project>(projects: readonly T[], sessions: readonly ProjectUse[]): T[] {
  const lastUsed = new Map<string, number>()
  for (const session of sessions) {
    if (!session.project) continue
    const seen = lastUsed.get(session.project)
    if (seen === undefined || session.updatedAt > seen) lastUsed.set(session.project, session.updatedAt)
  }
  return [...projects].sort((a, b) => (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0))
}

/** Why this project cannot be worked in right now, or nothing when it can. */
function missingReason(project: Project): string | undefined {
  return isFolder(project.path) ? undefined : `the folder of ${project.name} is gone (${project.path})`
}

/**
 * The one way the list changes: read, apply `change`, write the result back —
 * all while holding the lock. `next` absent means there was nothing to write.
 */
async function changeProjects<T>(
  change: (projects: Project[]) => { result: T; next?: Project[] },
): Promise<T> {
  const release = await lockProjects()
  try {
    // Strict: a read-modify-write must never be built on a tolerant empty reading
    // of a file it could not parse, which is how a corrupt one got erased.
    const projects = readProjectsStrict()
    const outcome = change(projects)
    if (outcome.next) await writePrivateFile(projectsFile(), serialize(outcome.next))
    return outcome.result
  } finally {
    await release()
  }
}

/**
 * Registers a folder and answers with the project, id and all. Refusals are
 * answered rather than thrown, each naming what was wrong: a folder that is not
 * there, a folder another project already is, a list at its ceiling. Nothing here
 * accepts a path it cannot work in, because a project that points nowhere is a
 * session that fails later, somewhere else, with no idea why.
 */
export async function addProject(input: NewProject): Promise<ProjectOutcome> {
  if (!input.path.trim()) return { ok: false, error: 'a project needs a folder' }
  const folder = resolveToolPath(process.cwd(), input.path)
  const problem = folderProblem(folder)
  if (problem) return { ok: false, error: problem }
  const name = input.name?.trim() || basename(folder)
  return changeProjects<ProjectOutcome>((projects) => {
    if (projects.length >= MAX_PROJECTS) {
      return { result: { ok: false, error: `at most ${MAX_PROJECTS} projects — remove one first` } }
    }
    const taken = projects.find((project) => project.path === folder)
    if (taken) return { result: { ok: false, error: `${folder} is already the project ${taken.name}` } }
    const id = generateNickname((candidate) => projects.some((project) => project.id === candidate))
    const project: Project = { id, name, path: folder, createdAt: Date.now() }
    return { result: { ok: true, project }, next: [...projects, project] }
  })
}

/**
 * Renames a project, moves it to another folder, or both. The id and the creation
 * time are the store's — a patch cannot move them — and what the patch leaves out
 * is kept as it was. A name set to nothing falls back to the folder's own name,
 * the same rule `addProject` keeps, so clearing one is a rename and not a lost
 * name.
 */
export async function updateProject(
  id: string,
  patch: { name?: string; path?: string },
): Promise<ProjectOutcome> {
  let folder: string | undefined
  if (patch.path !== undefined) {
    if (!patch.path.trim()) return { ok: false, error: 'a project needs a folder' }
    folder = resolveToolPath(process.cwd(), patch.path)
    const problem = folderProblem(folder)
    if (problem) return { ok: false, error: problem }
  }
  return changeProjects<ProjectOutcome>((projects) => {
    const target = projects.find((project) => project.id === id)
    if (!target) return { result: { ok: false, error: `no project with the id ${id}` } }
    if (folder !== undefined) {
      const taken = projects.find((project) => project.path === folder && project.id !== id)
      if (taken) return { result: { ok: false, error: `${folder} is already the project ${taken.name}` } }
      target.path = folder
    }
    if (patch.name !== undefined) {
      target.name = patch.name.trim() || basename(target.path)
    }
    return { result: { ok: true, project: target }, next: projects }
  })
}

/** Drops a project from the list. Its sessions stay; they just lose their folder. */
export async function removeProject(id: string): Promise<boolean> {
  return changeProjects((projects) => {
    const kept = projects.filter((project) => project.id !== id)
    if (kept.length === projects.length) return { result: false }
    return { result: true, next: kept }
  })
}

/** Why this folder cannot be a project's, or nothing when it can. */
function folderProblem(folder: string): string | undefined {
  return isFolder(folder) ? undefined : `there is no folder at ${folder}`
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isProject(value: unknown): value is Project {
  if (!value || typeof value !== 'object') return false
  const project = value as Record<string, unknown>
  return (
    typeof project.id === 'string' &&
    project.id.length > 0 &&
    typeof project.name === 'string' &&
    typeof project.path === 'string' &&
    project.path.length > 0
  )
}
