import process from 'node:process'
import {
  addProject,
  byRecentUse,
  placeProject,
  readProjects,
  removeProject,
  updateProject,
  type Project,
} from '../core/projects.js'
import { sessionsDir } from '../core/config/paths.js'
import { projectIconNames } from '../core/project-icons.js'
import { FileSessionStore } from '../core/sessions/index.js'
import { resolveToolPath } from '../core/tools/walk.js'
import { readProjectInstructions, rulesOf } from '../core/agent/instructions.js'
import { errorMessage } from '../util/errors.js'

export interface ProjectIo {
  out(line: string): void
  err(line: string): void
}

const USAGE = [
  'Usage:',
  '  milo projects                              list them',
  '  milo projects add <folder> [--name Milo] [--icon code]   register a folder a session may work in',
  '  milo projects rename <id|folder|name> [--name Milo]   rename one',
  '  milo projects move <id|folder|name> <folder>   point it at another folder',
  '  milo projects icon <id|folder|name> [icon]    choose the mark it wears',
  '  milo projects remove <id|folder|name>      drop it (the sessions that ran in it stay)',
  '',
  'A project is a folder the work happens in. A session started in one runs there —',
  "its tools, its subagent and its prompt all read from that folder instead of the",
  "install's own. The id is what a session carries, so renaming or moving a project",
  'does not touch the sessions that ran in it.',
].join('\n')

/**
 * `milo projects` — the terminal way to see and edit the folders Milo may work in.
 * The same list the Work screen draws and the same one a session reads its own
 * directory from, by hand.
 */
export async function runProjects(argv: string[], io: Partial<ProjectIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))

  const args = argv[0] === 'projects' ? argv.slice(1) : argv
  const [command, ...rest] = args

  try {
    switch (command ?? 'list') {
      case 'list':
        return await list(out)
      case 'add':
        return await add(rest, out, err)
      case 'rename':
        return await rename(rest, out, err)
      case 'move':
        return await move(rest, out, err)
      case 'icon':
        return await icon(rest, out, err)
      case 'remove':
      case 'rm':
        return await remove(rest, out, err)
      case 'help':
        out(USAGE)
        return 0
      default:
        err(`Unknown: milo projects ${command}`)
        err(USAGE)
        return 1
    }
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}

/**
 * The same order the Work screen draws: the folder worked in most recently first,
 * read from the sessions themselves rather than remembered in the file.
 */
async function list(out: ProjectIo['out']): Promise<number> {
  const projects = readProjects()
  if (projects.length === 0) {
    out('No projects.')
    out('Add one: milo projects add ~/code/milo --name Milo')
    return 0
  }

  const sessions = await new FileSessionStore({ dir: sessionsDir() }).list()
  for (const project of byRecentUse(projects, sessions)) {
    out(`${project.name}  (${project.id})`)
    // Where it is, and whether it is still there: a project whose folder went is
    // the one thing worth saying in a list, and it is said the same way a session
    // reading it would be answered.
    const placement = placeProject(project.id)
    out(`     ${project.path}${placement.ok ? '' : ` — ${placement.error}`}`)
    // The folder's own rules, when it has any: a session started here follows them, and
    // that is worth knowing before one is started. A folder with none says nothing —
    // silence is the ordinary case, not a warning.
    const rules = rulesOf(readProjectInstructions(placement))
    if (rules.kind === 'present') out(`     rules: ${rules.file}`)
    else if (rules.kind === 'unreadable') out(`     rules: ${rules.file} — ${rules.error}`)
  }
  return 0
}

async function add(argv: string[], out: ProjectIo['out'], err: ProjectIo['err']): Promise<number> {
  const { positionals, name, icon } = parseFlags(argv)
  const folder = positionals[0]
  if (!folder) {
    err('add needs a folder: milo projects add ~/code/milo --name Milo')
    err(USAGE)
    return 1
  }
  const outcome = await addProject({ path: folder, name, icon })
  if (!outcome.ok) {
    err(outcome.error)
    return 1
  }
  out(`Added ${outcome.project.name} (${outcome.project.id}) at ${outcome.project.path}.`)
  out('Sessions started in it read, write and run commands there.')
  return 0
}

async function rename(argv: string[], out: ProjectIo['out'], err: ProjectIo['err']): Promise<number> {
  const { positionals, name, icon } = parseFlags(argv)
  // A flag this command does not act on is said, not swallowed: a rename that quietly
  // ignored an icon would look like it had set one.
  if (icon !== undefined) {
    err('rename does not take --icon: use milo projects icon <project> <icon>')
    return 1
  }
  const selector = positionals[0]
  if (!selector) {
    err('rename needs a project: milo projects rename milo --name "Milo Work"')
    err(USAGE)
    return 1
  }
  const found = locate(selector)
  if (!found.ok) {
    err(found.error)
    return 1
  }
  // A rename with nothing to rename it to would be a command that does nothing
  // and says nothing, so it is answered instead.
  if (name === undefined) {
    err('rename needs --name: milo projects rename milo --name "Milo Work"')
    err(USAGE)
    return 1
  }
  const outcome = await updateProject(found.project.id, { name })
  if (!outcome.ok) {
    err(outcome.error)
    return 1
  }
  out(`Renamed ${found.project.id} to ${outcome.project.name}.`)
  return 0
}

async function move(argv: string[], out: ProjectIo['out'], err: ProjectIo['err']): Promise<number> {
  const { positionals, name, icon } = parseFlags(argv)
  if (name !== undefined || icon !== undefined) {
    err('move takes no flags: milo projects move <project> <folder>')
    return 1
  }
  const [selector, folder] = positionals
  if (!selector || !folder) {
    err('move needs a project and a folder: milo projects move milo ~/code/other')
    err(USAGE)
    return 1
  }
  const found = locate(selector)
  if (!found.ok) {
    err(found.error)
    return 1
  }
  const outcome = await updateProject(found.project.id, { path: folder })
  if (!outcome.ok) {
    err(outcome.error)
    return 1
  }
  out(`${outcome.project.name} (${outcome.project.id}) now works in ${outcome.project.path}.`)
  return 0
}

/**
 * The mark a project wears, from the fixed set the screens draw: an id here, an SF Symbol
 * on the phone and a drawing in the browser. With no mark named it answers with the ones
 * that exist, so a terminal does not have to guess or read the screens' source.
 */
async function icon(argv: string[], out: ProjectIo['out'], err: ProjectIo['err']): Promise<number> {
  const [selector, mark] = parseFlags(argv).positionals
  if (!selector || !mark) {
    err('icon needs a project and a mark: milo projects icon milo code')
    err(`Icons: ${projectIconNames()}`)
    return 1
  }
  const found = locate(selector)
  if (!found.ok) {
    err(found.error)
    return 1
  }
  const outcome = await updateProject(found.project.id, { icon: mark })
  if (!outcome.ok) {
    err(outcome.error)
    return 1
  }
  out(`${outcome.project.name} (${outcome.project.id}) now wears ${mark}.`)
  return 0
}

async function remove(argv: string[], out: ProjectIo['out'], err: ProjectIo['err']): Promise<number> {
  const selector = parseFlags(argv).positionals[0]
  if (!selector) {
    err('remove needs a project (see milo projects list).')
    return 1
  }
  const found = locate(selector)
  if (!found.ok) {
    err(found.error)
    return 1
  }
  if (!(await removeProject(found.project.id))) {
    err(`No project ${found.project.id}.`)
    return 1
  }
  // Said plainly: the sessions are not dropped with it. They lose the folder they
  // worked in, and the next turn of one says so rather than working elsewhere.
  out(`Removed ${found.project.name} (${found.project.id}). Sessions that ran there stay, without a project.`)
  return 0
}

/** The flags: what to call the project, and the mark it wears. */
function parseFlags(argv: string[]): { positionals: string[]; name?: string; icon?: string } {
  const positionals: string[] = []
  let name: string | undefined
  let icon: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === '--name') {
      const next = argv[++index]
      if (next === undefined) throw new Error('--name needs a value.')
      name = next
    } else if (token === '--icon') {
      const next = argv[++index]
      if (next === undefined) throw new Error('--icon needs a value.')
      icon = next
    } else if (token.startsWith('-')) {
      throw new Error(`Unknown option ${token}.`)
    } else {
      positionals.push(token)
    }
  }
  return { positionals, name, icon }
}

/**
 * The project a selector names: the id, then the folder, then the name. A name
 * that matches more than one is answered rather than guessed at — two projects
 * called `apps` are two different folders, and picking one silently is picking
 * wrong half the time.
 */
function locate(selector: string): { ok: true; project: Project } | { ok: false; error: string } {
  const projects = readProjects()
  const wanted = selector.trim()
  const byId = projects.find((project) => project.id === wanted)
  if (byId) return { ok: true, project: byId }
  const asPath = resolveToolPath(process.cwd(), wanted)
  const byPath = projects.find((project) => project.path === asPath)
  if (byPath) return { ok: true, project: byPath }
  const byName = projects.filter((project) => project.name.toLowerCase() === wanted.toLowerCase())
  if (byName.length === 1) return { ok: true, project: byName[0]! }
  if (byName.length > 1) {
    const ids = byName.map((project) => `${project.id} (${project.path})`).join(', ')
    return { ok: false, error: `${byName.length} projects are called ${wanted}: ${ids} — use the id.` }
  }
  return { ok: false, error: `No project "${wanted}". ${describe(projects)}` }
}

function describe(projects: Project[]): string {
  if (projects.length === 0) return 'None yet: milo projects add <folder>.'
  const known = projects.map((project) => `${project.id} — ${project.name}`).join(', ')
  return `Known: ${known}`
}
