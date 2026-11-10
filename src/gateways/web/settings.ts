import path from 'node:path'
import {
  mutateConfig,
  saveSecret as coreSaveSecret,
  removeSecret as coreRemoveSecret,
  type SecretGroup,
} from '../../core/settings.js'
import { PRESETS } from '../../core/config/presets.js'
import {
  beginChatGptBrowserLogin,
  beginChatGptDeviceLogin,
  chatGptStatus,
  enableChatGptProvider,
  forgetChatGptAccount,
  importCodexLogin,
  type ChatGptDeviceLogin,
  type ChatGptLogin,
} from '../../core/chatgpt/auth.js'
import { googleToolNames, googleWriteToolNames } from '../../core/tools/index.js'
import { googleState } from '../../core/google/state.js'
import { GOOGLE_TIERS } from '../../core/google/tiers.js'
import {
  listProviders,
  listProviderModels,
  readAuth,
  readConfig,
  saveConfig,
  setDisplay,
  setPermissionMode,
  setProvider as persistProvider,
  setReasoningEffort,
} from '../../core/config/load.js'
import { browserChromeDir, browserProfilesDir, embedEngineDir, memoryDir, skillsDir } from '../../core/config/paths.js'
import { mcpFacts } from '../../core/mcp/servers.js'
import { toolDisplayName } from '../tool-line.js'
import { modelNote, shortModel } from '../model-label.js'
import {
  CLASSIFIER_BACKENDS,
  COLOR_PALETTES,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  SEARCH_PROVIDERS,
  THINKING_LEVELS,
  TOOL_LEVELS,
  isColorPaletteId,
  type PaletteState,
} from './protocol.js'
import { colorPaletteNames } from '../../core/color-palettes.js'
import {
  ConfigSchema,
  DEFAULT_LOCAL_EMBED_MODEL,
  type Config,
  type ProviderEntry,
} from '../../core/config/schema.js'
import { chromeVersion, copyProfile, findProfiles, listBrowsers, tryInstall } from '../../core/browser/index.js'
import { INSTALL_SCOPE, memoryStatus } from '../../core/memory/index.js'
import { provisionEmbedding } from '../../core/memory/provision.js'
import { listInstalled, removeSkill, installSkill } from '../../core/skills/install.js'
import { fetchPopular } from '../../core/skills/catalog.js'
import { resolveSource } from '../../core/skills/sources.js'
import { peekSession, readSession, searchHistory } from '../../core/history.js'
import type { AgentRuntime } from '../../core/runtime.js'
import { writeSessionExport } from '../../core/export.js'
import { readTaskLists } from '../../core/task-lists.js'
import { taskListsTool } from '../../core/tools/task-lists.js'
import {
  findProject,
  unknownProjectError,
} from '../../core/projects.js'
import { SESSION_SURFACES, type SessionBackendKind, type SessionSurface } from '../../core/sessions/types.js'
import { browseFolders } from '../../core/browse.js'
import { JobRegistry } from './jobs.js'
import type { RegisterFile } from './transcript.js'
import { WebEmailSettings } from './settings/email.js'
import { WebWorkSettings } from './settings/work.js'
import { WebRoutineSettings } from './settings/routines.js'
import { optionalText, sessionId } from './settings/input.js'
import { listCommandCodeModels } from '../../core/command-code-models.js'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class WebSettings {
  private writeTail: Promise<unknown> = Promise.resolve()
  private readonly jobs = new JobRegistry()
  private readonly email: WebEmailSettings
  private readonly work: WebWorkSettings
  private readonly routines: WebRoutineSettings

  /** The sign-in waiting for a browser, so a second click shows the same URL instead of a second server. */
  private chatGpt: ChatGptLogin | ChatGptDeviceLogin | null = null

  /**
   * The browser is handed the running server's file registry, so a past run's
   * delivered files are served by the same `/attachment/<id>` a chat message's
   * are. Absent for a caller that serves no attachments — a test reading the
   * settings it builds.
   */
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly cwd: string,
    private readonly files?: { register?: RegisterFile; paletteChanged?: (state: PaletteState) => void },
  ) {
    this.email = new WebEmailSettings(runtime)
    this.work = new WebWorkSettings(runtime, cwd)
    this.routines = new WebRoutineSettings(runtime, files?.register ? { register: files.register.bind(files) } : undefined)
  }

  async handle(action: string, body: Record<string, unknown> = {}): Promise<unknown> {
    switch (action) {
      case 'overview': return this.overview()
      case 'save-config': return this.saveConfig(body)
      case 'set-model': return this.setModel(body)
      case 'set-effort': return this.setEffort(body)
      case 'providers': return listProviders()
      case 'set-provider': return this.setProvider(body)
      case 'save-secret': return this.saveSecret(body)
      case 'remove-secret': return this.removeSecret(body)
      case 'chatgpt-login': return this.chatGptLogin(body)
      case 'chatgpt-status': return this.chatGptReport()
      case 'chatgpt-logout': return this.chatGptSignOut()
      case 'models': return this.models(body)
      case 'command-code-models': return listCommandCodeModels()
      case 'sessions': return this.work.sessionSummaries()
      case 'session-backends': return this.runtime.sessionBackends()
      case 'new-session': return this.newSession(body)
      case 'resume-session': return this.resumeSession(body)
      case 'fork-session': return this.forkSession(body)
      case 'clear-session': return this.clearSession(body)
      case 'session-delete': return this.deleteSession(body)
      case 'session-rename': return this.renameSession(body)
      case 'session-seen': return this.sessionSeen(body)
      case 'transcript': return this.transcript(body)
      case 'session-peek': return this.sessionPeek(body)
      case 'export': return this.export(body)
      case 'skills': return this.skills()
      case 'popular-skills': return fetchPopular(20)
      case 'install-skill': return this.install(body)
      case 'remove-skill': return this.remove(body)
      case 'context-budget': return { budget: await this.runtime.contextBudget() }
      case 'history-search': return this.historySearch(body)
      case 'memory-notes': return this.memoryNotes(body)
      case 'forget-note': return this.forgetNote(body)
      case 'update-note': return this.updateNote(body)
      case 'routines': return this.routines.listRoutines()
      case 'task-lists': return readTaskLists()
      case 'task-list-action': return this.taskListAction(body)
      case 'projects': return this.work.projects()
      case 'project-action': return this.work.projectAction(body)
      case 'browse-folders': return browseFolders(optionalText(body.path), { cwd: this.cwd })
      case 'folder-create': return this.work.folderCreate(body)
      case 'project-tree': return this.work.projectTree(body)
      case 'project-folder': return this.work.projectFolder(body)
      case 'project-file': return this.work.projectFile(body)
      case 'project-diff': return this.work.projectDiff(body)
      case 'project-track': return this.work.projectTrack(body)
      case 'project-rules': return this.work.projectRules(body)
      case 'routine-feed': return this.routines.routineFeed()
      case 'routine-add': return this.routines.addRoutine(body)
      case 'routine-remove': return this.routines.removeRoutine(body)
      case 'routine-enable': return this.routines.enableRoutine(body)
      case 'routine-run': return this.routines.runRoutine(body)
      case 'routine-runs': return this.routines.routineRuns(body)
      case 'run-transcript': return this.routines.runTranscript(body)
      case 'browsers': return this.browsers()
      case 'profiles': return this.profiles()
      case 'mcp': return this.mcpReport()
      case 'mcp-reload': return this.mcpReload()
      case 'mcp-toggle': return this.mcpToggle(body)
      case 'job-start': return this.jobStart(body)
      case 'job-status': return this.jobStatus(body)
      case 'email-status':
      case 'email-unread':
      case 'email-seen':
      case 'email-inbox':
      case 'email-sort':
      case 'email-body':
      case 'email-message':
      case 'email-thread':
      case 'email-modify':
      case 'email-draft':
      case 'email-send':
      case 'email-assist':
      case 'email-label-create':
      case 'email-label-delete':
      case 'email-label-assign': return this.email.handle(action, body)
      // The action that arrived is named: a screen calling a route this daemon does not
      // have — because it is running an older build — has to say which one it was.
      default: throw new Error(`Unknown Settings action: "${action}".`)
    }
  }

  /**
   * What the Email screen needs to draw itself: the state of the grant and the
   * levels it could have been made at. The same `googleState` every surface reads.
   */
  private async taskListAction(body: Record<string, unknown>): Promise<unknown> {
    const parsed = taskListsTool.schema.safeParse(body)
    if (!parsed.success) throw new Error('Invalid task list action.')
    const result = await taskListsTool.execute(parsed.data, { cwd: this.cwd, signal: new AbortController().signal })
    if (result.isError) throw new Error(result.content)
    return { result: result.content, lists: readTaskLists() }
  }

  /**
   * The external tool servers as they are right now. Cheap by construction: it
   * reports state the manager already holds, and starts no process — what a
   * server is *doing* is asked for by `mcp-check`, which is a job precisely
   * because it can take seconds.
   */
  private mcpReport(): unknown {
    return mcpFacts(this.runtime.mcp)
  }

  /**
   * Reads `mcp.json` again and connects what is new in it. For an edit made by
   * hand — which is how a server is added — so the tools arrive without a restart.
   */
  private mcpReload(): unknown {
    const mcp = this.runtime.mcp
    if (!mcp) throw new Error('This Milo was built without MCP support.')
    mcp.reload()
    return this.mcpReport()
  }

  /**
   * Turns one server on or off. An immediate write, not a draft: `mcp.json` is
   * the file, this is the same edit made from here, and Save at the bottom of
   * the screen belongs to `config.yml`.
   */
  private async mcpToggle(body: Record<string, unknown>): Promise<unknown> {
    const name = optionalText(body.name) ?? ''
    const enabled = body.enabled === true
    const mcp = this.runtime.mcp
    if (!mcp) throw new Error('This Milo was built without MCP support.')
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('Invalid server name.')
    await mcp.setEnabled(name, enabled)
    return this.mcpReport()
  }

  private async overview(): Promise<unknown> {
    const config = readConfig()
    if (!config) throw new Error('Milo is not configured. Run `milo` in a terminal first.')
    const auth = readAuth()
    return {
      chatgpt: chatGptStatus(),
      config: sanitizeConfig(config),
      auth: {
        providers: maskRecord(auth.providers),
        // The Groq transcription key is a provider key filed on its own: the web
        // lists it under Audio, and `media.ts` still reads it from providers.groq.
        audio: maskRecord({ groq: auth.providers.groq ?? '' }),
        search: maskRecord(auth.search),
        gateways: maskRecord(auth.gateways),
      },
      presets: PRESETS.map(({ id, name, baseURL, wire, keyless, oauth, models, keyURL }) => ({ id, name, baseURL, wire, keyless, oauth, models, keyURL })),
      skills: this.skills(),
      sessions: await this.work.sessionSummaries(),
      memoryStats: memoryStatus(memoryDir()),
      // Reported with everything else, so a server that failed to start is
      // visible when the screen opens rather than only when it is asked about.
      mcp: this.mcpReport(),
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
        writeTools: googleWriteToolNames(auth.google ?? null),
        tiers: GOOGLE_TIERS.map(({ id, label, description }) => ({ id, label, description })),
      },
      // The values a settings screen may offer, said once here rather than copied
      // into every client: a client draws what the server accepts, so a mode this
      // app has never heard of still reaches the screen.
      options: {
        permissionModes: PERMISSION_MODES,
        toolLevels: TOOL_LEVELS,
        thinkingLevels: THINKING_LEVELS,
        efforts: EFFORT_LEVELS,
        searchProviders: SEARCH_PROVIDERS,
        classifierBackends: CLASSIFIER_BACKENDS,
        colorPalettes: COLOR_PALETTES,
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
      // A patch is merged section by section, not laid over the whole config: a
      // nested object the client sent only part of keeps the keys it left out
      // instead of resetting them to the schema's defaults on the way through.
      // Arrays replace — a list is a whole value, not a set to be added to.
      // A `null` clears an optional key (and nullable fields default back to `null`).
      const isPlain = (value: unknown): value is Record<string, unknown> =>
        Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      if ('palette' in patchConfig) {
        if (!isPlain(patchConfig.palette)) throw new Error('Expected a palette settings object.')
        if ('sync' in patchConfig.palette && typeof patchConfig.palette.sync !== 'boolean') {
          throw new Error('Palette sync must be true or false.')
        }
        if ('palette' in patchConfig.palette && !isColorPaletteId(patchConfig.palette.palette)) {
          throw new Error(`Unknown colour palette "${String(patchConfig.palette.palette)}". Use one of: ${colorPaletteNames()}.`)
        }
      }
      const merge = (base: unknown, patch: unknown): unknown => {
        if (!isPlain(patch) || !isPlain(base)) return patch
        const out: Record<string, unknown> = { ...base }
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) {
            delete out[key]
            continue
          }
          out[key] = merge(out[key], value)
        }
        return out
      }
      const merged = merge(current, patchConfig) as Record<string, unknown>
      const next = ConfigSchema.parse({ ...merged, providers })
      saveConfig(next)
      this.runtime.permissions?.update({
        mode: next.permissions.mode,
        allow: next.permissions.allow,
        deny: next.permissions.deny,
        threshold: next.permissions.jevThreshold,
      })
      this.runtime.setReasoningEffort(next.reasoningEffort)
      this.runtime.setMediaModels(next.media)
      this.runtime.setSessions(next.sessions)
      setPermissionMode(next.permissions.mode)
      setDisplay(next.display)
      setReasoningEffort(next.reasoningEffort)
      // What the install saves is what the sessions after this one start on — the
      // conversation in progress keeps what it is running, so nothing is hijacked
      // mid-turn. A provider move is resolved from disk and applied live, the same
      // switch the composer and `/provider` reach; no restart.
      if (next.provider !== current.provider) this.runtime.setDefaultProvider(next.provider, next.model)
      else if (next.model !== current.model) this.runtime.setDefaultModel(next.model)
      if (
        'palette' in patchConfig ||
        next.palette.sync !== current.palette.sync ||
        next.palette.palette !== current.palette.palette
      ) {
        this.files?.paletteChanged?.(next.palette)
      }
      return { saved: true, palette: next.palette }
    })
  }

  /**
   * Merges a patch into the config on disk and writes it back. Used by the setup
   * jobs — the browser's binary and profile, the embedding engine — which land
   * their result in the config only once the work has actually finished.
   */
  private patchConfig(mutate: (config: Config) => void): Promise<Config> {
    return this.serialize(() => {
      const res = mutateConfig(mutate)
      if (!res.ok) throw new Error(res.error)
      return res.value
    })
  }

  /**
   * Starts a ChatGPT sign-in and returns what the screen needs to show it. The
   * pending server is kept on this instance, so polling can tell when the grant
   * landed and a second click cannot bind the callback port twice.
   */
  private async chatGptLogin(body: Record<string, unknown>): Promise<unknown> {
    const status = chatGptStatus()
    if (status.signedIn) {
      enableChatGptProvider()
      return status
    }
    if (this.chatGpt) return chatGptPayload(this.chatGpt)
    // The common case: Codex is already signed in on this machine, and the same
    // grant is what Milo needs. A fresh sign-in is one flag away when it is not.
    if (body.new !== true) {
      try {
        if (await importCodexLogin()) {
          enableChatGptProvider()
          return chatGptStatus()
        }
      } catch {
        // The Codex grant could not be refreshed; the browser flow is next.
      }
    }
    const pending =
      body.mode === 'device' ? await beginChatGptDeviceLogin() : await beginChatGptBrowserLogin()
    this.chatGpt = pending
    void pending.wait
      .then(() => this.serialize(() => enableChatGptProvider()))
      .catch(() => undefined)
      .finally(() => {
        this.chatGpt = null
      })
    return chatGptPayload(pending)
  }

  /**
   * The grant's state, and the one write that belongs with it: a signed-in
   * install should list `chatgpt` as a provider without anyone adding it by
   * hand. Called by the phone and the browser after a poll turns true.
   */
  private chatGptReport(): unknown {
    const status = chatGptStatus()
    if (status.signedIn) enableChatGptProvider()
    return status
  }

  private chatGptSignOut(): unknown {
    this.chatGpt?.cancel()
    this.chatGpt = null
    forgetChatGptAccount()
    return { signedIn: false }
  }

  private async saveSecret(body: Record<string, unknown>): Promise<unknown> {
    return this.serialize(async () => {
      const group = typeof body.group === 'string' ? body.group : ''
      const id = typeof body.id === 'string' ? body.id : ''
      const value = typeof body.value === 'string' ? body.value : ''
      // Audio is the Groq transcription key: it is stored where `media.ts` reads
      // it, under providers, and only the heading it is listed under differs.
      const res = group === 'audio'
        ? coreSaveSecret('providers', 'groq', value)
        : coreSaveSecret(group as SecretGroup, id, value)
      if (!res.ok) throw new Error(res.error)
      return { saved: res.value }
    })
  }

  private async removeSecret(body: Record<string, unknown>): Promise<unknown> {
    return this.serialize(() => {
      const group = typeof body.group === 'string' ? body.group : ''
      const id = typeof body.id === 'string' ? body.id : ''
      const res = group === 'audio'
        ? coreRemoveSecret('providers', 'groq')
        : coreRemoveSecret(group as SecretGroup, id)
      if (!res.ok) throw new Error(res.error)
      return { removed: res.value }
    })
  }

  /**
   * Switches the running model and writes the pair down, so the next start
   * builds what this one is running. `runtime.setModel` resolves which provider
   * serves the model, and that provider is written with it: a model id belongs
   * to a provider, so recording one alone would leave the file claiming a
   * provider the model does not come from.
   */
  private setModel(body: Record<string, unknown>): unknown {
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) throw new Error('A model id is required.')
    this.runtime.setModel(model)
    persistProvider(this.runtime.provider.id, model)
    return { model }
  }

  /**
   * Moves the install onto another provider and writes the pair down. The switch
   * is resolved from disk now and applied to the running runtime — the same
   * `setProvider` the composer and `/provider` reach — so it needs no restart.
   */
  private setProvider(body: Record<string, unknown>): unknown {
    const id = typeof body.provider === 'string' ? body.provider.trim() : ''
    if (!id) throw new Error('A provider id is required.')
    if (!listProviders().some((item) => item.id === id)) {
      throw new Error(`Provider "${id}" is not configured or has no key.`)
    }
    this.runtime.setProvider(id)
    persistProvider(this.runtime.provider.id, this.runtime.model)
    return { provider: this.runtime.provider.id, providerName: this.runtime.providerName, model: this.runtime.model }
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
    // The same catalog `/model` reads, so the picker and the chat command cannot
    // come to disagree about what a configured provider serves. The two labels
    // are projected here, from the one shortening every surface shares, so a
    // client that cannot import it — the phone — reads the same words instead of
    // keeping a copy that would drift.
    return (await listProviderModels(id)).map((model) => ({
      ...model,
      label: shortModel(model.id),
      note: modelNote(model),
    }))
  }

  private skills(): unknown {
    return listInstalled(skillsDir())
  }

  /**
   * Installs a skill. A source that holds several — a repository with more than
   * one `SKILL.md` — is not guessed at: the names come back so the person picks,
   * and the second call names the one they chose.
   */
  private async install(body: Record<string, unknown>): Promise<unknown> {
    const source = body.source
    const explicitSkill = typeof body.skill === 'string' ? body.skill : undefined
    if (typeof source !== 'string' || !source.trim()) throw new Error('Enter a skill source first.')
    const resolved = await resolveSource(source.trim(), { cwd: this.cwd, skill: explicitSkill })
    if (resolved.length === 0) throw new Error('No skill was found at that source.')
    if (resolved.length > 1) return { needChoice: resolved.map((skill) => skill.name) }
    const skill = resolved[0]!
    const written = await this.serialize(() => installSkill({ name: skill.name, markdown: skill.markdown, origin: skill.origin }, skillsDir()))
    return { installed: skill.name, replaced: written.replaced }
  }

  private remove(body: Record<string, unknown>): unknown {
    const name = body.name
    if (typeof name !== 'string' || !SAFE_ID.test(name) || name.includes('..')) throw new Error('Invalid skill name.')
    return removeSkill(name, skillsDir())
  }

  private async newSession(body: Record<string, unknown>): Promise<unknown> {
    const chatId = validChatId(body.chatId)
    const scope = { gateway: 'web', chatId }
    const project = optionalText(body.project)
    if (project && !findProject(project)) throw new Error(unknownProjectError(project))
    const surface = optionalText(body.surface)
    if (surface !== undefined && !(SESSION_SURFACES as readonly string[]).includes(surface)) {
      throw new Error(`Unknown surface "${surface}". Use one of: ${SESSION_SURFACES.join(', ')}.`)
    }
    const rawBackend = body.backend
    if (rawBackend !== undefined && rawBackend !== 'milo' && rawBackend !== 'command-code') {
      throw new Error(`Unknown Session backend "${String(rawBackend)}". Use one of: milo, command-code.`)
    }
    const backend = rawBackend as SessionBackendKind | undefined
    if (backend === 'command-code' && !project) {
      throw new Error('Command Code Sessions must be started in a Work project.')
    }
    if (backend === 'command-code' && body.confirmed !== true) {
      throw new Error('Confirm Command Code access before creating this Session.')
    }
    if (backend === 'command-code' && body.plan === true) {
      throw new Error('Plan mode is controlled by Command Code for this Session.')
    }
    const session = await this.runtime.newSession(
      scope,
      typeof body.title === 'string' ? body.title : undefined,
      {
        ...(project ? { project } : {}),
        ...(surface ? { surface: surface as SessionSurface } : {}),
        ...(backend ? { backend } : {}),
        ...(backend === 'command-code' ? { confirmed: true, creationKey: chatId } : {}),
      },
    )
    if (body.plan === true) session.setPlan(true)
    return { id: session.id }
  }

  /**
   * The projects, in the one order every surface draws them: the folder worked in
   * most recently first. The views say whether each folder is still there; the
   * sessions say when it was last used.
   */
  private async resumeSession(body: Record<string, unknown>): Promise<unknown> {
    const chatId = validChatId(body.chatId)
    if (typeof body.id !== 'string') throw new Error('Invalid session id.')
    const session = await this.runtime.resumeSession({ gateway: 'web', chatId }, body.id)
    if (!session) throw new Error('Session not found.')
    return { id: session.id }
  }

  private async forkSession(body: Record<string, unknown>): Promise<unknown> {
    const chatId = validChatId(body.chatId)
    const rawId = body.sessionId ?? body.id
    if (typeof rawId !== 'string') throw new Error('Invalid session id.')
    const sourceId = sessionId(rawId)
    const upToTurn = typeof body.upToTurn === 'number' ? body.upToTurn : undefined
    const title = typeof body.title === 'string' ? body.title : undefined
    const session = await this.runtime.forkSession({ gateway: 'web', chatId }, sourceId, { upToTurn, title })
    if (!session) throw new Error('Session not found.')
    return { id: session.id }
  }

  private async clearSession(body: Record<string, unknown>): Promise<unknown> {
    const chatId = validChatId(body.chatId)
    const session = await this.runtime.getSession({ gateway: 'web', chatId })
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
      throw new Error('That is the session you are in — start a new one first.')
    }
    if (!(await this.runtime.removeSession(id))) throw new Error('Session not found.')
    return { removed: true }
  }

  /**
   * A session was looked at. A screen calls this when the session is in front of
   * the person — opened, or holding a turn it watched — so the unread mark clears
   * here and on every other surface, which is what the install-wide watermark is
   * for.
   */
  private sessionSeen(body: Record<string, unknown>): unknown {
    this.runtime.markSessionSeen(sessionId(body.id))
    return { seen: true }
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

  /**
   * Where a session left off — the last few things said, for the card a long press lifts
   * on the phone. A read and nothing else: a peek at a session is not a visit to it, so
   * this never opens, moves or renames one.
   */
  private async sessionPeek(body: Record<string, unknown>): Promise<unknown> {
    const id = sessionId(body.id)
    const native = await this.runtime.nativeSessionHistory(id)
    if (!native) return peekSession(id)
    return native.messages.flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return []
      const text = message.content.filter((part) => part.type === 'text').map((part) => part.text).join('').trim()
      if (!text) return []
      return [{ who: message.role === 'user' ? 'you' as const : 'milo' as const, text: text.length > 240 ? `${text.slice(0, 239)}…` : text }]
    }).slice(-3)
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
        text: (entry.text ?? entry.reasoning ?? (entry.tool ? toolDisplayName(entry.tool.name) : '')).replace(/\s+/g, ' ').trim().slice(0, 240),
      })),
    }
  }

  private async memoryNotes(body: Record<string, unknown>): Promise<unknown> {
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    const offset = typeof body.offset === 'number' && Number.isSafeInteger(body.offset) && body.offset >= 0 ? body.offset : 0
    const page = await this.runtime.memory.list(INSTALL_SCOPE, { limit: 51, offset, query })
    return { notes: page.slice(0, 50), hasMore: page.length > 50 }
  }

  private async forgetNote(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) throw new Error('A note id is required.')
    if (!await this.runtime.memory.forget(INSTALL_SCOPE, id)) throw new Error('No unique note matches that id.')
    return { removed: true }
  }

  private async updateNote(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === 'string' ? body.id : ''
    const text = typeof body.text === 'string' ? body.text : ''
    const result = await this.runtime.memory.update(INSTALL_SCOPE, id, text)
    if (!result.ok) throw new Error(result.error)
    return result
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

    if (kind === 'mcp-check') {
      const name = optionalText(body.name) ?? ''
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('Invalid server name.')
      const mcp = this.runtime.mcp
      if (!mcp) throw new Error('This Milo was built without MCP support.')
      return { id: this.jobs.start(kind, async (say) => {
        say(`Connecting to ${name}…`)
        const tools = await mcp.check(name)
        for (const tool of tools) {
          const first = tool.description?.split('\n')[0]?.trim()
          say(`${name}.${tool.name}${first ? ` — ${first}` : ''}`)
        }
        return { tools: tools.length, names: tools.map((tool) => tool.name), checkedAt: Date.now() }
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

function chatGptPayload(pending: ChatGptLogin | ChatGptDeviceLogin): Record<string, unknown> {
  if ('userCode' in pending) {
    return { url: pending.verificationUrl, userCode: pending.userCode, device: true }
  }
  return { url: pending.url }
}

function maskRecord(record: Record<string, string>): Record<string, { set: boolean; masked?: string }> {
  return Object.fromEntries(Object.entries(record).map(([id, value]) => [id, { set: Boolean(value), ...(value ? { masked: '••••••••••••••••' } : {}) }]))
}

function validChatId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid chat id.')
  return value
}
