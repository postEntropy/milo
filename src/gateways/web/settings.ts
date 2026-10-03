import path from 'node:path'
import { listModels, normalizeModels } from '../../core/providers/models.js'
import { PRESETS } from '../../core/config/presets.js'
import { googleState } from '../../core/google/state.js'
import { googleToolNames } from '../../core/tools/index.js'
import {
  readAuth,
  readConfig,
  resolveApiKey,
  saveAuth,
  saveConfig,
  setDisplay,
  setModel as persistModel,
  setPermissionMode,
  setReasoningEffort,
} from '../../core/config/load.js'
import { browserChromeDir, browserProfilesDir, embedEngineDir, memoryDir } from '../../core/config/paths.js'
import {
  ConfigSchema,
  DEFAULT_LOCAL_EMBED_MODEL,
  type Auth,
  type Config,
  type ProviderEntry,
} from '../../core/config/schema.js'
import { chromeVersion, copyProfile, findProfiles, listBrowsers, tryInstall } from '../../core/browser/index.js'
import { INSTALL_SCOPE, memoryStatus } from '../../core/memory/index.js'
import { provisionEmbedding } from '../../core/memory/provision.js'
import {
  addRoutine,
  describeTarget,
  describeWhen,
  findRoutine,
  nextRunAt,
  parseWhen,
  readRoutines,
  removeRoutineWithRuns,
  ROUTINE_GATEWAYS,
  runRoutineOnce,
  setEnabled,
  type Routine,
  type RoutineGateway,
  type RoutineTarget,
} from '../../core/routines.js'
import { skillsDirFor, listInstalled, removeSkill, installSkill } from '../../core/skills/install.js'
import { fetchPopular } from '../../core/skills/catalog.js'
import { resolveSource } from '../../core/skills/sources.js'
import { readSession, searchHistory } from '../../core/history.js'
import type { AgentRuntime } from '../../core/runtime.js'
import { writeSessionExport } from '../../core/export.js'
import { JobRegistry } from './jobs.js'
import { transcriptOf, type RegisterFile } from './transcript.js'

/** How many runs the front page's timeline shows, newest across every routine. */
const FEED_LIMIT = 20

const SESSION_ID = /^[a-z]+-[a-z]+-\d{1,3}$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class WebSettings {
  private writeTail: Promise<unknown> = Promise.resolve()
  private readonly jobs = new JobRegistry()

  /**
   * The browser is handed the running server's file registry, so a past run's
   * delivered files are served by the same `/attachment/<id>` a chat message's
   * are. Absent for a caller that serves no attachments — a test reading the
   * settings it builds.
   */
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly cwd: string,
    private readonly files?: { register: RegisterFile },
  ) {}

  async handle(action: string, body: Record<string, unknown> = {}): Promise<unknown> {
    switch (action) {
      case 'overview': return this.overview()
      case 'save-config': return this.saveConfig(body)
      case 'set-model': return this.setModel(body)
      case 'set-effort': return this.setEffort(body)
      case 'save-secret': return this.saveSecret(body)
      case 'remove-secret': return this.removeSecret(body)
      case 'models': return this.models(body)
      case 'sessions': return this.runtime.listSessions()
      case 'new-session': return this.newSession(body)
      case 'resume-session': return this.resumeSession(body)
      case 'fork-session': return this.forkSession(body)
      case 'clear-session': return this.clearSession(body)
      case 'session-delete': return this.deleteSession(body)
      case 'session-rename': return this.renameSession(body)
      case 'transcript': return this.transcript(body)
      case 'export': return this.export(body)
      case 'skills': return this.skills()
      case 'popular-skills': return fetchPopular(20)
      case 'install-skill': return this.install(body)
      case 'remove-skill': return this.remove(body)
      case 'context-window': return { window: await this.runtime.contextWindow() }
      case 'history-search': return this.historySearch(body)
      case 'memory-notes': return this.memoryNotes()
      case 'forget-note': return this.forgetNote(body)
      case 'routines': return this.listRoutines()
      case 'routine-feed': return this.routineFeed()
      case 'routine-add': return this.addRoutine(body)
      case 'routine-remove': return this.removeRoutine(body)
      case 'routine-enable': return this.enableRoutine(body)
      case 'routine-run': return this.runRoutine(body)
      case 'routine-runs': return this.routineRuns(body)
      case 'run-transcript': return this.runTranscript(body)
      case 'browsers': return this.browsers()
      case 'profiles': return this.profiles()
      case 'job-start': return this.jobStart(body)
      case 'job-status': return this.jobStatus(body)
      default: throw new Error('Unknown Settings action.')
    }
  }

  private async overview(): Promise<unknown> {
    const config = readConfig()
    if (!config) throw new Error('Milo is not configured. Run `milo` in a terminal first.')
    const auth = readAuth()
    return {
      config: sanitizeConfig(config),
      auth: {
        providers: maskRecord(auth.providers),
        search: maskRecord(auth.search),
        gateways: maskRecord(auth.gateways),
      },
      presets: PRESETS.map(({ id, name, baseURL, wire, keyless, models, keyURL }) => ({ id, name, baseURL, wire, keyless, models, keyURL })),
      skills: this.skills(),
      sessions: await this.runtime.listSessions(),
      memoryStats: memoryStatus(memoryDir()),
      live: {
        model: this.runtime.model,
        effort: this.runtime.reasoningEffort,
        permissionMode: this.runtime.permissions?.mode ?? 'ask',
        skills: this.runtime.skills.map(({ name, description }) => ({ name, description })),
        browser: Boolean(this.runtime.browser),
      },
      // The grant, never the secret: the state, and the names of what it bought.
      // `googleState` is the same function `milo google status` and the setup
      // screen read, so the three cannot disagree about it.
      google: {
        ...googleState(config, auth),
        tools: googleToolNames(auth.google ?? null),
      },
    }
  }

  private async saveConfig(body: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      const current = readConfig()
      if (!current) throw new Error('Milo is not configured.')
      const patch = body.config
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected a config object.')
      const patchConfig = patch as Record<string, unknown>
      const patchedProviders = patchConfig.providers && typeof patchConfig.providers === 'object'
        ? patchConfig.providers as Record<string, ProviderEntry>
        : current.providers
      const providers = Object.fromEntries(Object.entries(patchedProviders).map(([id, entry]) => [
        id,
        { ...entry, headers: entry.headers ?? current.providers[id]?.headers },
      ]))
      const next = ConfigSchema.parse({ ...current, ...patchConfig, providers })
      saveConfig(next)
      this.runtime.permissions?.update({
        mode: next.permissions.mode,
        allow: next.permissions.allow,
        deny: next.permissions.deny,
        threshold: next.permissions.jevThreshold,
      })
      this.runtime.setReasoningEffort(next.reasoningEffort)
      this.runtime.setMediaModels(next.media)
      setPermissionMode(next.permissions.mode)
      setDisplay(next.display)
      setReasoningEffort(next.reasoningEffort)
      // The model the install saves for next time is the one the sessions after
      // this one start on — the conversation in progress keeps the model it is
      // running, so nothing is hijacked mid-turn. A provider change still waits
      // for a restart, since its client is built from the config at startup.
      if (next.model !== current.model && next.provider === current.provider) this.runtime.setDefaultModel(next.model)
      return { saved: true }
    })
  }

  /**
   * Merges a patch into the config on disk and writes it back. Used by the setup
   * jobs — the browser's binary and profile, the embedding engine — which land
   * their result in the config only once the work has actually finished.
   */
  private patchConfig(mutate: (config: Config) => void): Promise<Config> {
    return this.serialize(() => {
      const current = readConfig()
      if (!current) throw new Error('Milo is not configured.')
      const next = structuredClone(current)
      mutate(next)
      const parsed = ConfigSchema.parse(next)
      saveConfig(parsed)
      return parsed
    })
  }

  private async saveSecret(body: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      const group = body.group
      const id = body.id
      const value = body.value
      if (!['providers', 'search', 'gateways'].includes(String(group)) || typeof id !== 'string' || typeof value !== 'string') {
        throw new Error('Invalid secret update.')
      }
      const auth = readAuth()
      const record = auth[group as keyof Auth] as Record<string, string>
      if (!value.trim()) return { saved: false }
      record[id] = value.trim()
      saveAuth(auth)
      return { saved: true }
    })
  }

  private async removeSecret(body: Record<string, unknown>): Promise<unknown> {
    return this.serialize(() => {
      const group = body.group
      const id = body.id
      if (!['providers', 'search', 'gateways'].includes(String(group)) || typeof id !== 'string') throw new Error('Invalid secret update.')
      const auth = readAuth()
      delete (auth[group as keyof Auth] as Record<string, string>)[id]
      saveAuth(auth)
      return { removed: true }
    })
  }

  /** Switches the running model and writes it down, so the next turn uses it. */
  private setModel(body: Record<string, unknown>): unknown {
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) throw new Error('A model id is required.')
    this.runtime.setModel(model)
    persistModel(model)
    return { model }
  }

  /** Switches the reasoning effort and writes it down, so the next turn uses it. */
  private setEffort(body: Record<string, unknown>): unknown {
    const effort = typeof body.effort === 'string' ? body.effort.trim() : ''
    if (!['low', 'medium', 'high'].includes(effort)) throw new Error('Reasoning effort must be low, medium or high.')
    const validated = effort as 'low' | 'medium' | 'high'
    this.runtime.setReasoningEffort(validated)
    setReasoningEffort(validated)
    return { effort: validated }
  }

  private async models(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.provider === 'string' ? body.provider : ''
    const config = readConfig()
    if (!config) throw new Error('Milo is not configured.')
    const entry = config.providers[id] as ProviderEntry | undefined
    if (!entry) throw new Error(`Provider "${id}" is not configured.`)
    const modelUrl = new URL(entry.baseURL)
    if (modelUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(modelUrl.hostname)) {
      throw new Error('Model catalog URLs must use HTTPS unless they point to localhost.')
    }
    const apiKey = resolveApiKey(id, entry, readAuth())
    return listModels({ baseURL: entry.baseURL, wire: entry.wire, headers: entry.headers, apiKey })
      .catch(() => normalizeModels(PRESETS.find((preset) => preset.id === id)?.models ?? []))
  }

  private skills(): unknown {
    return {
      global: listInstalled(skillsDirFor('global', this.cwd)),
      project: listInstalled(skillsDirFor('project', this.cwd)),
    }
  }

  /**
   * Installs a skill. A source that holds several — a repository with more than
   * one `SKILL.md` — is not guessed at: the names come back so the person picks,
   * and the second call names the one they chose.
   */
  private async install(body: Record<string, unknown>): Promise<unknown> {
    const source = body.source
    const scope = body.scope === 'project' ? 'project' : 'global'
    const explicitSkill = typeof body.skill === 'string' ? body.skill : undefined
    if (typeof source !== 'string' || !source.trim()) throw new Error('Enter a skill source first.')
    const resolved = await resolveSource(source.trim(), { cwd: this.cwd, skill: explicitSkill })
    if (resolved.length === 0) throw new Error('No skill was found at that source.')
    if (resolved.length > 1) return { needChoice: resolved.map((skill) => skill.name) }
    const skill = resolved[0]!
    const written = await this.serialize(() => installSkill({ name: skill.name, markdown: skill.markdown, origin: skill.origin }, skillsDirFor(scope, this.cwd)))
    return { installed: skill.name, scope, replaced: written.replaced }
  }

  private remove(body: Record<string, unknown>): unknown {
    const name = body.name
    const scope = body.scope === 'project' ? 'project' : 'global'
    if (typeof name !== 'string' || !SAFE_ID.test(name) || name.includes('..')) throw new Error('Invalid skill name.')
    return removeSkill(name, skillsDirFor(scope, this.cwd))
  }

  private async newSession(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = validConversationId(body.conversationId)
    const scope = { gateway: 'web', conversationId }
    const session = await this.runtime.newSession(scope, typeof body.title === 'string' ? body.title : undefined)
    return { id: session.id }
  }

  private async resumeSession(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = validConversationId(body.conversationId)
    if (typeof body.id !== 'string') throw new Error('Invalid session id.')
    const session = await this.runtime.resumeSession({ gateway: 'web', conversationId }, body.id)
    if (!session) throw new Error('Session not found.')
    return { id: session.id }
  }

  private async forkSession(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = validConversationId(body.conversationId)
    const rawId = body.sessionId ?? body.id
    if (typeof rawId !== 'string') throw new Error('Invalid session id.')
    const sourceId = sessionId(rawId)
    const upToTurn = typeof body.upToTurn === 'number' ? body.upToTurn : undefined
    const title = typeof body.title === 'string' ? body.title : undefined
    const session = await this.runtime.forkSession({ gateway: 'web', conversationId }, sourceId, { upToTurn, title })
    if (!session) throw new Error('Session not found.')
    return { id: session.id }
  }

  private async clearSession(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = validConversationId(body.conversationId)
    const session = await this.runtime.getSession({ gateway: 'web', conversationId })
    await session.clear()
    return { cleared: true }
  }

  /**
   * Deletes a saved session outright. The one being looked at is refused: it is
   * bound to the conversation, and a conversation bound to a session that is gone
   * would quietly start a new one on the next message.
   */
  private async deleteSession(body: Record<string, unknown>): Promise<unknown> {
    const id = sessionId(body.id)
    if (typeof body.current === 'string' && body.current === id) {
      throw new Error('That is the conversation you are in — start a new one first.')
    }
    if (!(await this.runtime.removeSession(id))) throw new Error('Session not found.')
    return { removed: true }
  }

  private async renameSession(body: Record<string, unknown>): Promise<unknown> {
    const id = sessionId(body.id)
    const title = typeof body.title === 'string' ? body.title : ''
    const renamed = await this.runtime.renameSession(id, title)
    if (!renamed) throw new Error('Session not found.')
    return { renamed: true, id, title: title.trim() || undefined }
  }

  private transcript(body: Record<string, unknown>): unknown {
    return readSession(sessionId(body.id))
  }

  private async export(body: Record<string, unknown>): Promise<unknown> {
    const id = sessionId(body.id)
    const summary = (await this.runtime.listSessions()).find((item) => item.id === id)
    return writeSessionExport({ id, title: summary?.title, format: body.format === 'json' ? 'json' : 'md' })
  }

  /**
   * What the past turns said about a term, for the search box. The whole log, not
   * the session list: a word that a tidied-up title dropped is still findable here.
   */
  private historySearch(body: Record<string, unknown>): unknown {
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) return { hits: [] }
    const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.min(body.limit, 50) : 20
    return {
      hits: searchHistory(query, { limit }).map((entry) => ({
        session: entry.session,
        at: entry.at,
        kind: entry.kind,
        text: (entry.text ?? entry.reasoning ?? entry.tool?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
      })),
    }
  }

  private async memoryNotes(): Promise<unknown> {
    return {
      notes: await this.runtime.memory.list(INSTALL_SCOPE, { limit: 200 }),
      stats: memoryStatus(memoryDir()),
    }
  }

  private async forgetNote(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new Error('A note id is required.')
    return { removed: await this.runtime.memory.forget(INSTALL_SCOPE, id) }
  }

  private listRoutines(): unknown {
    return readRoutines().map((routine) => this.routineView(routine))
  }

  /**
   * The most recent runs across every routine, newest first — a timeline of what
   * the routines have said, mixed together rather than read one routine at a time.
   */
  private async routineFeed(): Promise<unknown> {
    const runs: Array<{ routine: Routine; id: string; at: number }> = []
    for (const routine of readRoutines()) {
      for (const run of (await this.runtime.listRuns(routine.id)).slice(0, FEED_LIMIT)) {
        runs.push({ routine, id: run.id, at: run.updatedAt })
      }
    }
    const recent = runs.sort((a, b) => b.at - a.at).slice(0, FEED_LIMIT)
    return Promise.all(recent.map(async (entry) => ({
      id: entry.routine.id,
      runId: entry.id,
      routine: entry.routine.name ?? entry.routine.prompt,
      at: entry.at,
      answer: await this.runText(entry.id),
    })))
  }

  /** The words a run produced, flattened and cut for a one-line gist. */
  private async runText(runId: string): Promise<string> {
    const record = await this.runtime.loadSession(runId)
    if (!record) return ''
    return record.messages
      .flatMap((message) => message.content)
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  }

  private async addRoutine(body: Record<string, unknown>): Promise<unknown> {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) throw new Error('A prompt is required.')
    const when = parseWhen({
      every: optionalText(body.every),
      at: optionalText(body.at),
      days: stringList(body.days),
    })
    if (!when) throw new Error('Set a time: an interval like "2h", or a clock time like "08:00" with optional days.')
    const allow = stringList(body.allow)
    const routine = await addRoutine({
      prompt,
      name: optionalText(body.name),
      when,
      target: routineTarget(body.target),
      allow: allow && allow.length > 0 ? allow : undefined,
      enabled: true,
    })
    return { routine: this.routineView(routine) }
  }

  private async removeRoutine(body: Record<string, unknown>): Promise<unknown> {
    const id = optionalText(body.id)
    if (!id || !(await removeRoutineWithRuns(this.runtime, id))) throw new Error('No routine with that id.')
    return { removed: true }
  }

  private async enableRoutine(body: Record<string, unknown>): Promise<unknown> {
    const id = optionalText(body.id)
    if (!id) throw new Error('A routine id is required.')
    const enabled = body.enabled !== false
    if (!(await setEnabled(id, enabled))) throw new Error('No routine with that id.')
    return { id, enabled }
  }

  /**
   * Fires one now and answers with what it said, and with the id of the run it
   * just made — so the surface can open the run rather than draw the answer a
   * second way. It does not deliver: the chat would get it twice.
   */
  private async runRoutine(body: Record<string, unknown>): Promise<unknown> {
    const id = optionalText(body.id)
    if (!id) throw new Error('A routine id is required.')
    const routine = findRoutine(id)
    if (!routine) throw new Error('No routine with that id.')
    const { id: runId, answer, failure } = await runRoutineOnce(this.runtime, routine)
    return { ...(runId ? { runId } : {}), answer, failure }
  }

  /**
   * What a routine has produced, newest first, a page at a time. The runs are
   * kept for good now, so the surface asks for more as it scrolls rather than
   * being handed a history nobody bounded.
   */
  private async routineRuns(body: Record<string, unknown>): Promise<unknown> {
    const id = optionalText(body.id)
    if (!id) throw new Error('A routine id is required.')
    if (!findRoutine(id)) throw new Error('No routine with that id.')
    const all = await this.runtime.listRuns(id)
    const offset = typeof body.offset === 'number' && body.offset > 0 ? Math.floor(body.offset) : 0
    const limit = typeof body.limit === 'number' && body.limit > 0 ? Math.min(Math.floor(body.limit), 100) : 20
    return {
      total: all.length,
      runs: all.slice(offset, offset + limit).map((run) => ({ id: run.id, at: run.updatedAt })),
    }
  }

  /**
   * One run as the page draws a conversation. Read-only: it binds nothing and
   * takes no lease, so opening a past run does not take the conversation over
   * from whoever is in it.
   */
  private async runTranscript(body: Record<string, unknown>): Promise<unknown> {
    const record = await this.runtime.loadSession(sessionId(body.id))
    if (!record) throw new Error('No such run.')
    // A run that delivered a file is only drawable where the files can be
    // served; said rather than dropped, so a picture never vanishes from a run.
    const register = this.files?.register ?? ((file: { name: string }) => {
      throw new Error(`Serving ${file.name} needs the web server's file registry.`)
    })
    return transcriptOf(record.messages, register)
  }

  private async browsers(): Promise<unknown> {
    const found = await listBrowsers()
    return Promise.all(found.map(async (browser) => ({ ...browser, version: await chromeVersion(browser.path) })))
  }

  private async profiles(): Promise<unknown> {
    return findProfiles()
  }

  /**
   * Long-running setup work as a job the browser can poll: a Chrome for Testing
   * download, copying a profile out of another browser, and provisioning the
   * local embedding engine. Each writes its result into the config as it lands.
   */
  private jobStart(body: Record<string, unknown>): unknown {
    const kind = optionalText(body.kind) ?? ''

    if (kind === 'browser-install') {
      return { id: this.jobs.start(kind, async (say) => {
        const installed = await tryInstall(browserChromeDir(), say)
        if (!installed) throw new Error('The download did not finish — see the log above.')
        await this.patchConfig((config) => {
          config.browser.chromePath = installed.path
          config.browser.enabled = true
        })
        return { path: installed.path, version: installed.version, restart: true }
      }) }
    }

    if (kind === 'profile-copy') {
      const id = optionalText(body.id) ?? ''
      const dir = optionalText(body.dir) ?? ''
      if (!SAFE_ID.test(id) || id.includes('..')) throw new Error('Invalid browser id.')
      if (!dir) throw new Error('A profile directory is required.')
      return { id: this.jobs.start(kind, async (say) => {
        const target = path.join(browserProfilesDir(), id)
        const result = await copyProfile(dir, target, { onProgress: say, label: id })
        await this.patchConfig((config) => {
          config.browser.profileDir = result.dir
          config.browser.enabled = true
        })
        return { profileDir: result.dir, bytes: result.bytes, parts: result.parts, restart: true }
      }) }
    }

    if (kind === 'embed-provision') {
      const model = optionalText(body.model) ?? DEFAULT_LOCAL_EMBED_MODEL
      return { id: this.jobs.start(kind, async (say) => {
        const provisioned = await provisionEmbedding({ dir: embedEngineDir(), model, onProgress: say })
        // Pulled, then released: the engine is started again per serving process,
        // the way `milo setup` leaves it.
        provisioned.stop()
        await this.patchConfig((config) => {
          config.memory.embedding = { provider: 'ollama', model: provisioned.model, url: provisioned.url }
        })
        return { model: provisioned.model, url: provisioned.url, version: provisioned.version, restart: true }
      }) }
    }

    throw new Error(`Unknown job kind: ${kind || '(none)'}`)
  }

  private jobStatus(body: Record<string, unknown>): unknown {
    const id = optionalText(body.id) ?? ''
    const job = this.jobs.view(id)
    if (!job) throw new Error('No such job.')
    return job
  }

  private routineView(routine: Routine): Record<string, unknown> {
    return {
      ...routine,
      whenLabel: describeWhen(routine.when),
      targetLabel: describeTarget(routine.target),
      nextRunAt: routine.enabled ? nextRunAt(routine.when, new Date()).getTime() : null,
    }
  }

  private serialize<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.writeTail.then(work, work)
    this.writeTail = next.catch(() => undefined)
    return next
  }
}

function sanitizeConfig(config: Config): Config {
  return {
    ...config,
    providers: Object.fromEntries(Object.entries(config.providers).map(([id, entry]) => [
      id,
      {
        ...entry,
        headers: undefined,
      },
    ])),
  }
}

function maskRecord(record: Record<string, string>): Record<string, { set: boolean; masked?: string }> {
  return Object.fromEntries(Object.entries(record).map(([id, value]) => [id, { set: Boolean(value), ...(value ? { masked: '••••••••••••••••' } : {}) }]))
}

function validConversationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid conversation id.')
  return value
}

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('Invalid session id.')
  return value
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

function routineTarget(value: unknown): RoutineTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A destination is required.')
  const target = value as Record<string, unknown>
  if (target.gateway === 'none') return { gateway: 'none' }
  const gateway = String(target.gateway ?? '')
  if (!(ROUTINE_GATEWAYS as readonly string[]).includes(gateway)) {
    throw new Error(`The destination must be one of ${ROUTINE_GATEWAYS.join(', ')}, or none.`)
  }
  const conversationId = optionalText(target.conversationId)
  if (!conversationId) throw new Error('The destination needs a conversation id.')
  return { gateway: gateway as RoutineGateway, conversationId }
}
