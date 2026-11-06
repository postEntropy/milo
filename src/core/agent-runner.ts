import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { ensurePrivateDir, writePrivateFile } from '../util/fs.js'
import { readOwnInstructions, readProjectInstructions } from './agent/instructions.js'
import { MILO_HOME } from './config/paths.js'
import { findProject, withProjectPlacement, type Project, type ProjectPlacement } from './projects.js'
import { HerdrNotInstalled, herdrCall, parseHerdrTerminal, parseHerdrTerminalList, type HerdrTerminal } from './herdr-rpc.js'

export interface ExternalAgentRun {
  address: string
  state: 'live' | 'finished'
  createdAt: number
  cwd: string
  runId: string | null
  exitCode: number | null
  reason: string | null
}

export interface ExternalAgentScreen {
  run: ExternalAgentRun
  text: string
  complete: boolean
}

export interface LegacyAgentCandidate {
  address: string
  cwd: string
  createdAt: number
  state: 'live' | 'finished' | 'unknown'
  released: boolean
}

export interface ExternalAgentRecovery {
  pending: string[]
  releasedPending: string[]
  legacy: LegacyAgentCandidate[]
  legacyScan: 'pending' | 'complete' | 'released'
}

export interface ExternalAgentList extends ExternalAgentRecovery {
  runs: ExternalAgentRun[]
}

type AgentProjectState = {
  version: 2
  projectId: string
  incarnation: string
  createdAt: number
  legacyScan: ExternalAgentList['legacyScan']
  pending: string[]
  releasedPending: string[]
  legacy: Array<Omit<LegacyAgentCandidate, 'released'>>
  releasedLegacy: string[]
}

type RpcCall = typeof herdrCall
type Terminal = HerdrTerminal

const LABEL_AGENT = 'milo-agent'
const LABEL_PROJECT = 'milo-project'
const LABEL_CREATED = 'milo-project-created'
const LABEL_INCARNATION = 'milo-project-incarnation'
const AGENT = 'command-code'

function incarnation(project: Project): string {
  if (!project.incarnation) throw new Error(`Project ${project.id} has no stable identity yet.`)
  return project.incarnation
}

function markerKey(project: Project, identity: string | number): string {
  return createHash('sha256').update(JSON.stringify([project.id, identity])).digest('hex')
}

function markerPath(project: Project): string {
  return path.join(MILO_HOME, 'agent-projects', `${markerKey(project, incarnation(project))}.json`)
}

function legacyMarkerPaths(project: Project): string[] {
  const previousKey = markerKey(project, project.createdAt)
  return [
    path.join(MILO_HOME, 'agent-projects', `${previousKey}.json`),
    path.join(MILO_HOME, 'agent-projects', previousKey),
  ]
}

export function hasAgentMarker(project: Project): boolean {
  return exists(markerPath(project)) || legacyMarkerPaths(project).some(exists)
}

function exists(file: string): boolean {
  try {
    statSync(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function emptyState(project: Project): AgentProjectState {
  return {
    version: 2, projectId: project.id, incarnation: incarnation(project), createdAt: project.createdAt,
    legacyScan: 'pending', pending: [], releasedPending: [], legacy: [], releasedLegacy: [],
  }
}

function readState(project: Project): AgentProjectState | null {
  let raw: string | undefined
  for (const file of [markerPath(project), ...legacyMarkerPaths(project)]) {
    try {
      raw = readFileSync(file, 'utf8')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (raw === undefined) return null
  if (raw.trim() === '') return emptyState(project)
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('The project’s external-agent recovery record is unreadable.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The project’s external-agent recovery record is invalid.')
  const state = value as Record<string, unknown>
  const validCandidates = Array.isArray(state.legacy) && state.legacy.every((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const item = candidate as Record<string, unknown>
    return typeof item.address === 'string' && typeof item.cwd === 'string' && typeof item.createdAt === 'number' &&
      ['live', 'finished', 'unknown'].includes(String(item.state))
  })
  const validLegacy = Array.isArray(state.legacy) && validCandidates
  const validCore = state.projectId === project.id && state.createdAt === project.createdAt &&
    ['pending', 'complete', 'released'].includes(String(state.legacyScan)) &&
    Array.isArray(state.pending) && state.pending.every((id) => typeof id === 'string') &&
    validLegacy && Array.isArray(state.releasedLegacy) && state.releasedLegacy.every((id) => typeof id === 'string')
  const releasedPending = state.releasedPending ?? []
  if (state.version === 1 && validCore && Array.isArray(releasedPending) &&
    releasedPending.every((id: unknown) => typeof id === 'string')) {
    return {
      version: 2,
      projectId: project.id,
      incarnation: incarnation(project),
      createdAt: project.createdAt,
      legacyScan: state.legacyScan as AgentProjectState['legacyScan'],
      pending: state.pending as string[],
      releasedPending: (state.releasedPending as string[] | undefined) ?? [],
      legacy: state.legacy as AgentProjectState['legacy'],
      releasedLegacy: state.releasedLegacy as string[],
    }
  }
  if (state.version !== 2 || state.projectId !== project.id || state.incarnation !== project.incarnation || !validCore ||
    !Array.isArray(state.releasedPending) || !state.releasedPending.every((id) => typeof id === 'string')) {
    throw new Error('The project’s external-agent recovery record is invalid.')
  }
  return state as AgentProjectState
}

async function writeState(project: Project, state: AgentProjectState): Promise<void> {
  const file = markerPath(project)
  ensurePrivateDir(path.dirname(file))
  await writePrivateFile(file, `${JSON.stringify(state, null, 2)}\n`)
}

export async function removeAgentMarker(project: Project): Promise<void> {
  await Promise.all([rm(markerPath(project), { force: true }), ...legacyMarkerPaths(project).map((file) => rm(file, { force: true }))])
}

function projectLabels(projectId: string): Record<string, string> {
  const project = findProject(projectId)
  if (!project) throw new Error(`No project with the id ${projectId}.`)
  return {
    [LABEL_AGENT]: AGENT,
    [LABEL_PROJECT]: project.id,
    [LABEL_CREATED]: String(project.createdAt),
    [LABEL_INCARNATION]: incarnation(project),
  }
}

function projectOf(placement: ProjectPlacement): Project {
  if (placement.ok) return placement.project
  if (placement.project) return placement.project
  throw new Error(placement.error)
}

function view(item: Terminal): ExternalAgentRun {
  return {
    address: item.address,
    state: item.state as ExternalAgentRun['state'],
    createdAt: item.created_ms,
    cwd: item.cwd,
    runId: item.labels['milo-run'] ?? null,
    exitCode: item.exit_code ?? null,
    reason: item.reason ?? null,
  }
}

async function ensureState(project: Project, assertLock: () => void = () => {}): Promise<AgentProjectState> {
  const state = readState(project) ?? emptyState(project)
  if (!exists(markerPath(project))) {
    assertLock()
    await writeState(project, state)
  }
  return state
}

function listResult(value: unknown): Terminal[] {
  return parseHerdrTerminalList(value)
}

function legacyCandidate(item: Terminal): Omit<LegacyAgentCandidate, 'released'> {
  return {
    address: item.address,
    cwd: item.cwd,
    createdAt: item.created_ms,
    state: item.state as LegacyAgentCandidate['state'],
  }
}

async function reconcileProjectAgents(project: Project, call: RpcCall, assertLock: () => void = () => {}): Promise<ExternalAgentList> {
  const state = await ensureState(project, assertLock)
  const before = JSON.stringify(state)
  assertLock()
  const found = listResult(await call('terminal.list', {
    all: true,
    labels: { [LABEL_AGENT]: AGENT, [LABEL_PROJECT]: project.id },
  })).filter((item) => item.labels[LABEL_AGENT] === AGENT && item.labels[LABEL_PROJECT] === project.id)
  const incarnationLabel = incarnation(project)
  const current = found.filter((item) => item.labels[LABEL_INCARNATION] === incarnationLabel)
  const old = found.filter((item) => item.labels[LABEL_INCARNATION] !== incarnationLabel)
  const oldByAddress = new Map(state.legacy.map((item) => [item.address, item]))
  for (const item of old) oldByAddress.set(item.address, legacyCandidate(item))
  const foundOld = new Set(old.map((item) => item.address))
  for (const candidate of oldByAddress.values()) {
    if (!foundOld.has(candidate.address) && candidate.state === 'live') candidate.state = 'unknown'
  }
  const pendingMatches = new Map<string, Terminal[]>()
  for (const item of current) {
    const runId = item.labels['milo-run']
    if (!runId || !state.pending.includes(runId)) continue
    pendingMatches.set(runId, [...(pendingMatches.get(runId) ?? []), item])
  }
  const resolved = [...pendingMatches]
    .filter(([, matches]) => matches.length === 1 && matches[0]?.reason !== 'spawn_pending')
    .map(([runId]) => runId)
  state.pending = state.pending.filter((runId) => !resolved.includes(runId))
  state.legacy = [...oldByAddress.values()]
  if (state.legacyScan === 'pending') state.legacyScan = 'complete'
  if (JSON.stringify(state) !== before) {
    assertLock()
    await writeState(project, state)
  }
  return {
    runs: current.map(view).sort((a, b) => b.createdAt - a.createdAt),
    pending: [...state.pending],
    releasedPending: [...state.releasedPending],
    legacy: state.legacy.map((candidate) => ({ ...candidate, released: state.releasedLegacy.includes(candidate.address) })),
    legacyScan: state.legacyScan,
  }
}

function assertAgentStateSettled(result: ExternalAgentList): void {
  if (result.pending.length > 0) throw new Error(`Resolve or explicitly release pending external agent runs before moving or removing this project: ${result.pending.join(', ')}.`)
  if (result.legacyScan === 'pending') throw new Error('Check old Herdr terminals or explicitly release the legacy scan before moving or removing this project.')
  if (result.runs.some((run) => run.state === 'live')) throw new Error('Stop this project’s external agents before removing or moving the project.')
  const uncheckedLegacy = result.legacy.filter((run) => !run.released && run.state !== 'finished')
  if (uncheckedLegacy.length > 0) throw new Error(`Stop or explicitly release unverified legacy terminals before moving or removing this project: ${uncheckedLegacy.map((run) => run.address).join(', ')}.`)
}

function recoveryView(state: AgentProjectState): ExternalAgentRecovery {
  return {
    pending: [...state.pending],
    releasedPending: [...state.releasedPending],
    legacy: state.legacy.map((candidate) => ({ ...candidate, released: state.releasedLegacy.includes(candidate.address) })),
    legacyScan: state.legacyScan,
  }
}

export async function assertProjectAgentsSettled(project: Project, assertLock: () => void = () => {}): Promise<void> {
  if (!hasAgentMarker(project)) return
  const state = readState(project)
  try {
    assertAgentStateSettled(await new ExternalAgents().listLocked(project, assertLock))
  } catch (error) {
    if (state?.legacyScan === 'released' && state.pending.length === 0) return
    if (error instanceof HerdrNotInstalled) {
      throw new Error(`${error.message} Open Work → Agents to review or explicitly release the project check.`)
    }
    throw error
  }
}

export class ExternalAgents {
  constructor(private readonly call: RpcCall = herdrCall) {}

  async recovery(projectId: string): Promise<ExternalAgentRecovery> {
    return withProjectPlacement(projectId, async (placement) => {
      const project = projectOf(placement)
      const state = readState(project) ?? emptyState(project)
      return recoveryView(state)
    })
  }

  async list(projectId: string): Promise<ExternalAgentList> {
    return withProjectPlacement(projectId, async (placement, assertLock) => this.listLocked(projectOf(placement), assertLock))
  }

  async listLocked(project: Project, assertLock: () => void = () => {}): Promise<ExternalAgentList> {
    return reconcileProjectAgents(project, this.call, assertLock)
  }

  async releasePending(projectId: string, runId: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error('Confirm that this unresolved launch may still appear later.')
    await withProjectPlacement(projectId, async (placement, assertLock) => {
      const project = projectOf(placement)
      const state = await ensureState(project, assertLock)
      if (!state.pending.includes(runId)) throw new Error('That pending launch is not in this project.')
      state.pending = state.pending.filter((id) => id !== runId)
      state.releasedPending.push(runId)
      assertLock()
      await writeState(project, state)
    })
  }

  async releaseLegacy(projectId: string, address: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error('Confirm that this old terminal may not belong to this project.')
    await withProjectPlacement(projectId, async (placement, assertLock) => {
      const project = projectOf(placement)
      const state = await ensureState(project, assertLock)
      if (!state.legacy.some((candidate) => candidate.address === address)) throw new Error('That legacy terminal is not recorded for this project.')
      if (!state.releasedLegacy.includes(address)) state.releasedLegacy.push(address)
      assertLock()
      await writeState(project, state)
    })
  }

  async releaseLegacyScan(projectId: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error('Confirm proceeding without checking old Herdr terminals.')
    await withProjectPlacement(projectId, async (placement, assertLock) => {
      const project = projectOf(placement)
      const state = await ensureState(project, assertLock)
      if (state.legacyScan === 'released') throw new Error('The external-agent check was already released.')
      state.legacyScan = 'released'
      state.releasedLegacy = [...new Set([...state.releasedLegacy, ...state.legacy.map((run) => run.address)])]
      assertLock()
      await writeState(project, state)
    })
  }

  async stopLegacy(projectId: string, address: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error('Confirm stopping this unverified legacy terminal.')
    await withProjectPlacement(projectId, async (placement, assertLock) => {
      const project = projectOf(placement)
      const state = await ensureState(project, assertLock)
      const candidate = state.legacy.find((run) => run.address === address)
      if (!candidate) throw new Error('That legacy terminal is not recorded for this project.')
      assertLock()
      const item = parseHerdrTerminal(await this.call('terminal.get', { terminal: address }))
      this.verifyLegacy(project, item, candidate)
      if (item.state !== 'live') throw new Error('This legacy agent has already stopped.')
      assertLock()
      await this.call('terminal.kill', { terminal: address })
      await reconcileProjectAgents(project, this.call, assertLock)
    })
  }

  private verifyLegacy(project: Project, item: Terminal, candidate: Omit<LegacyAgentCandidate, 'released'>): void {
    if (item.address !== candidate.address || item.cwd !== candidate.cwd ||
      item.labels[LABEL_AGENT] !== AGENT || item.labels[LABEL_PROJECT] !== project.id ||
      item.labels[LABEL_INCARNATION] === incarnation(project)) {
      throw new Error('The legacy terminal no longer matches this candidate.')
    }
  }

  async start(projectId: string, prompt: string, confirmed: boolean): Promise<ExternalAgentRun> {
    if (!confirmed) throw new Error('Confirm that Command Code can edit files and run commands without Milo approval.')
    if (!prompt.trim()) throw new Error('A task is required.')
    if (prompt.length > 20_000) throw new Error('The task is too long.')
    return withProjectPlacement(projectId, async (placement, assertLock) => {
      if (!placement.ok) throw new Error(placement.error)
      const reconciled = await reconcileProjectAgents(placement.project, this.call, assertLock)
      assertAgentStateSettled(reconciled)
      const own = readOwnInstructions()
      const project = readProjectInstructions(placement)
      for (const rules of [own, project]) {
        if (rules.kind === 'unreadable') throw new Error(`Could not read ${rules.file}: ${rules.error}`)
      }
      const instructions = [own, project]
        .filter((rules) => rules.kind === 'present')
        .map((rules) => `Instructions from ${rules.file}:\n${rules.text}`)
      const task = [...instructions, `Task:\n${prompt.trim()}`].join('\n\n')
      const state = readState(placement.project) ?? emptyState(placement.project)
      const runId = randomUUID()
      const labels = {
        [LABEL_AGENT]: AGENT, [LABEL_PROJECT]: projectId,
        [LABEL_CREATED]: String(placement.project.createdAt),
        [LABEL_INCARNATION]: incarnation(placement.project),
        'milo-run': runId,
      }
      state.pending.push(runId)
      assertLock()
      await writeState(placement.project, state)
      try {
        assertLock()
        const result = parseHerdrTerminal(await this.call('terminal.run', {
          argv: ['cmd', '--yolo', '--skip-onboarding', task],
          cwd: placement.project.path,
          labels,
          no_parent: true,
          outlive_parent: true,
        }))
        if (!Object.entries(labels).every(([key, value]) => result.labels[key] === value)) {
          throw new Error('Herdr did not label the agent run as requested.')
        }
        if (result.reason !== 'spawn_pending') {
          state.pending = state.pending.filter((id) => id !== runId)
          assertLock()
          await writeState(placement.project, state)
        }
        return view(result)
      } catch (error) {
        if (error instanceof HerdrNotInstalled) {
          state.pending = state.pending.filter((id) => id !== runId)
          assertLock()
          await writeState(placement.project, state)
          throw error
        }
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${reason} The agent may have started; check the pending run ${runId} before retrying.`)
      }
    })
  }

  private async owned(projectId: string, address: string): Promise<Terminal> {
    if (!/^(?:[a-z0-9][a-z0-9._-]*\/)?t[a-z0-9]+$/.test(address)) throw new Error('Invalid agent terminal.')
    const labels = projectLabels(projectId)
    const item = parseHerdrTerminal(await this.call('terminal.get', { terminal: address }))
    if (item.address !== address || !Object.entries(labels).every(([key, value]) => item.labels[key] === value)) {
      throw new Error('That agent does not belong to this project.')
    }
    return item
  }

  async read(projectId: string, address: string): Promise<ExternalAgentScreen> {
    const item = await this.owned(projectId, address)
    return this.readScreen(item)
  }

  async readLegacy(projectId: string, address: string): Promise<ExternalAgentScreen> {
    return withProjectPlacement(projectId, async (placement, assertLock) => {
      const project = projectOf(placement)
      const state = await ensureState(project, assertLock)
      const candidate = state.legacy.find((run) => run.address === address)
      if (!candidate) throw new Error('That legacy terminal is not recorded for this project.')
      assertLock()
      const item = parseHerdrTerminal(await this.call('terminal.get', { terminal: address }))
      this.verifyLegacy(project, item, candidate)
      return this.readScreen(item)
    })
  }

  private async readScreen(item: Terminal): Promise<ExternalAgentScreen> {
    const result = await this.call('terminal.read', { terminal: item.address, lines: 200 })
    if (!result || typeof result !== 'object' || typeof (result as { text?: unknown }).text !== 'string' ||
      typeof (result as { complete?: unknown }).complete !== 'boolean') {
      throw new Error('Herdr returned an invalid terminal screen.')
    }
    const screen = result as { text: string; complete: boolean }
    return { run: view(item), text: screen.text, complete: screen.complete }
  }

  async send(projectId: string, address: string, text: string): Promise<void> {
    const item = await this.owned(projectId, address)
    if (item.state !== 'live') throw new Error('This agent has stopped.')
    if (!text.trim()) throw new Error('A message is required.')
    if (text.length > 20_000) throw new Error('The message is too long.')
    await this.call('terminal.send', { terminal: address, text: text.trim() })
  }

  async stop(projectId: string, address: string): Promise<void> {
    const item = await this.owned(projectId, address)
    if (item.state !== 'live') throw new Error('This agent has already stopped.')
    await this.call('terminal.kill', { terminal: address })
  }
}
