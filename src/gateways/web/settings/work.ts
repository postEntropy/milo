import type { AgentRuntime } from '../../../core/runtime.js'
import {
  addProject, byRecentUse, placeProject, projectViews, removeProject, updateProject,
  type ProjectView,
} from '../../../core/projects.js'
import { createFolder } from '../../../core/browse.js'
import { createWorkFolder, workFile, workTree } from '../../../core/work.js'
import { startTracking, workDiff } from '../../../core/work-diff.js'
import { PROJECT_RULES_PROMPT, readProjectInstructions, rulesOf } from '../../../core/agent/instructions.js'
import { placeWorkSessions } from '../../../core/work-sessions.js'
import { optionalText, projectId, requireText } from './input.js'

export class WebWorkSettings {
  constructor(private readonly runtime: AgentRuntime, private readonly cwd: string) {}

  async projects(): Promise<ProjectView[]> {
    return byRecentUse(projectViews(), await this.runtime.listSessions())
  }

  /** Sessions carry the daemon's Work classification and short-list visibility. */
  async sessionSummaries() {
    const projects = projectViews()
    const sessions = await this.runtime.listSessions()
    return placeWorkSessions(sessions, projects)
  }

  /**
   * Adding, changing and dropping a project from the Work screen. Every argument
   * is validated here, and a refusal comes back as the reason the store gave —
   * which names the folder or the project it is about. Like the task lists, the
   * answer is the sentence plus the whole list back, so the screen draws what the
   * store decided instead of guessing at what a change made.
   */
  async projectAction(body: Record<string, unknown>): Promise<unknown> {
    const action = body.action
    if (action === 'add') {
      const outcome = await addProject({
        path: requireText(body.path, 'folder'),
        name: optionalText(body.name),
        icon: body.icon === undefined ? undefined : requireText(body.icon, 'icon'),
      })
      if (!outcome.ok) throw new Error(outcome.error)
      return { result: `Added ${outcome.project.name} at ${outcome.project.path}.`, projects: await this.projects() }
    }
    const id = projectId(body.id)
    if (action === 'remove') {
      const removed = await removeProject(id)
      if (!removed.removed) throw new Error(`No project ${id}.`)
      return {
        result: `Removed ${id}. Its sessions stay, without a project.${removed.warning ? ` ${removed.warning}` : ''}`,
        projects: await this.projects(),
      }
    }
    if (action === 'update') {
      const name = body.name === undefined ? undefined : (optionalText(body.name) ?? '')
      const path = body.path === undefined ? undefined : requireText(body.path, 'folder')
      const icon = body.icon === undefined ? undefined : requireText(body.icon, 'icon')
      if (name === undefined && path === undefined && icon === undefined) {
        throw new Error('An update needs a name, a folder, or an icon.')
      }
      const outcome = await updateProject(id, {
        ...(name !== undefined ? { name } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(icon !== undefined ? { icon } : {}),
      })
      if (!outcome.ok) throw new Error(outcome.error)
      return { result: `Updated ${outcome.project.name}.`, projects: await this.projects() }
    }
    throw new Error(`Invalid project action: "${String(action)}". Use add, update or remove.`)
  }

  /**
   * A project's folder as a tree, for the Work screen. The id is checked here and the
   * reading happens in the core, so the same tree is what the phone and the browser
   * draw — including what was cut and what could not be read, which ride back with it.
   */
  async projectTree(body: Record<string, unknown>): Promise<unknown> {
    const outcome = await workTree(projectId(body.id))
    if (!outcome.ok) throw new Error(outcome.error)
    return outcome
  }

  /**
   * A folder made while choosing one: the picker a project is added with can make the
   * folder it was missing instead of ending at "there is no folder at …". It answers the
   * listing inside the new folder, so the picker stands in it.
   */
  folderCreate(body: Record<string, unknown>): unknown {
    return createFolder(optionalText(body.parent), requireText(body.name, 'folder'), { cwd: this.cwd })
  }

  /**
   * A folder made in a project, for the Work screen. The id, the parent and the name are
   * checked in the core; the answer is the whole tree after the write, so the screen draws
   * the folder it just made in the same round trip.
   */
  async projectFolder(body: Record<string, unknown>): Promise<unknown> {
    const outcome = await createWorkFolder(
      projectId(body.id),
      optionalText(body.parent) ?? '',
      requireText(body.name, 'folder'),
    )
    if (!outcome.ok) throw new Error(outcome.error)
    return outcome
  }

  /**
   * One file of a project, read as a page of text. `offset` continues a longer file;
   * everything else about the page — how many lines, where it stopped — is the core's,
   * so the person reading a file reads the same page the agent would be handed.
   */
  async projectFile(body: Record<string, unknown>): Promise<unknown> {
    const offset = typeof body.offset === 'number' && body.offset > 0 ? Math.floor(body.offset) : undefined
    const outcome = await workFile(projectId(body.id), requireText(body.path, 'file'), {
      ...(offset !== undefined ? { offset } : {}),
    })
    if (!outcome.ok) throw new Error(outcome.error)
    return outcome
  }

  /**
   * What a project's folder has changed, read from its own repository. A folder that
   * is not one is answered with that — the screen says so instead of drawing an empty
   * list that would read as "nothing changed" — so an `ok` outcome carries whether
   * there was anything to read at all.
   */
  async projectDiff(body: Record<string, unknown>): Promise<unknown> {
    const outcome = await workDiff(projectId(body.id))
    if (!outcome.ok) throw new Error(outcome.error)
    return outcome
  }

  /**
   * Recording what a project's folder holds now as its first state — the button under
   * "nothing is recorded here yet". It is their folder and their repository: nothing
   * asks, and what was done is said. The answer carries the changes it made readable,
   * so the screen draws them instead of asking again.
   */
  async projectTrack(body: Record<string, unknown>): Promise<unknown> {
    const id = projectId(body.id)
    const outcome = await startTracking(id)
    if (!outcome.ok) throw new Error(outcome.error)
    const diff = await workDiff(id)
    if (!diff.ok) throw new Error(diff.error)
    return diff
  }

  /**
   * Whether a project's folder carries rules, and the words that ask the agent to write
   * them. Only the status travels: the file's own text is for the prompt, not for a
   * screen, and a screen only says that the rules are there. The `prompt` is the same
   * text on every surface — it lives in the core, so the phone and the browser hand over
   * one thing rather than two that drift.
   */
  projectRules(body: Record<string, unknown>): unknown {
    const id = projectId(body.id)
    const placement = placeProject(id)
    // The project has to exist: a line about the rules of a project that is not there
    // would be a screen answering for something that is not in the list.
    if (!placement.project) throw new Error(`No project with the id ${id}.`)
    return { ...rulesOf(readProjectInstructions(placement)), prompt: PROJECT_RULES_PROMPT }
  }

 }
