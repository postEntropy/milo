import { listModels } from '../../core/providers/models.js'
import { PRESETS } from '../../core/config/presets.js'
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
import { ConfigSchema, type Auth, type Config, type ProviderEntry } from '../../core/config/schema.js'
import { skillsDirFor, listInstalled, removeSkill, installSkill } from '../../core/skills/install.js'
import { fetchPopular } from '../../core/skills/catalog.js'
import { resolveSource } from '../../core/skills/sources.js'
import { readSession } from '../../core/history.js'
import type { AgentRuntime } from '../../core/runtime.js'
import { writeSessionExport } from '../../core/export.js'

export class WebStudio {
  private writeTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly runtime: AgentRuntime, private readonly cwd: string) {}

  async handle(action: string, body: Record<string, unknown> = {}): Promise<unknown> {
    switch (action) {
      case 'overview': return this.overview()
      case 'save-config': return this.saveConfig(body)
      case 'set-model': return this.setModel(body)
      case 'save-secret': return this.saveSecret(body)
      case 'remove-secret': return this.removeSecret(body)
      case 'models': return this.models(body)
      case 'sessions': return this.runtime.listSessions()
      case 'new-session': return this.newSession(body)
      case 'resume-session': return this.resumeSession(body)
      case 'clear-session': return this.clearSession(body)
      case 'transcript': return this.transcript(body)
      case 'export': return this.export(body)
      case 'skills': return this.skills()
      case 'popular-skills': return fetchPopular(20)
      case 'install-skill': return this.install(body)
      case 'remove-skill': return this.remove(body)
      default: throw new Error('Unknown Studio action.')
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
      live: {
        model: this.runtime.reasoningEffort,
        permissionMode: this.runtime.permissions?.mode ?? 'ask',
        skills: this.runtime.skills.map(({ name, description }) => ({ name, description })),
        browser: Boolean(this.runtime.browser),
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
      setPermissionMode(next.permissions.mode)
      setDisplay(next.display)
      setReasoningEffort(next.reasoningEffort)
      return { saved: true }
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
      .catch(() => PRESETS.find((preset) => preset.id === id)?.models.map((model) => ({ id: model })) ?? [])
  }

  private skills(): unknown {
    return {
      global: listInstalled(skillsDirFor('global', this.cwd)),
      project: listInstalled(skillsDirFor('project', this.cwd)),
    }
  }

  private async install(body: Record<string, unknown>): Promise<unknown> {
    const source = body.source
    const scope = body.scope === 'project' ? 'project' : 'global'
    const explicitSkill = typeof body.skill === 'string' ? body.skill : undefined
    if (typeof source !== 'string' || !source.trim()) throw new Error('Enter a skill source first.')
    const resolved = await resolveSource(source.trim(), { cwd: this.cwd, skill: explicitSkill })
    if (resolved.length !== 1) throw new Error('This source contains multiple skills. Choose one skill by name before installing.')
    const skill = resolved[0]
    return this.serialize(() => installSkill({ name: skill.name, markdown: skill.markdown, origin: skill.origin }, skillsDirFor(scope, this.cwd)))
  }

  private remove(body: Record<string, unknown>): unknown {
    const name = body.name
    const scope = body.scope === 'project' ? 'project' : 'global'
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) throw new Error('Invalid skill name.')
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

  private async clearSession(body: Record<string, unknown>): Promise<unknown> {
    const conversationId = validConversationId(body.conversationId)
    const session = await this.runtime.getSession({ gateway: 'web', conversationId })
    await session.clear()
    return { cleared: true }
  }

  private transcript(body: Record<string, unknown>): unknown {
    if (typeof body.id !== 'string' || !/^[a-z]+-[a-z]+-\d{1,3}$/.test(body.id)) throw new Error('Invalid session id.')
    return readSession(body.id)
  }

  private async export(body: Record<string, unknown>): Promise<unknown> {
    if (typeof body.id !== 'string' || !/^[a-z]+-[a-z]+-\d{1,3}$/.test(body.id)) throw new Error('Invalid session id.')
    const summary = (await this.runtime.listSessions()).find((item) => item.id === body.id)
    return writeSessionExport({ id: body.id, title: summary?.title, format: body.format === 'json' ? 'json' : 'md' })
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
  return Object.fromEntries(Object.entries(record).map(([id, value]) => [id, { set: Boolean(value), ...(value ? { masked: '••••••••' } : {}) }]))
}

function validConversationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid conversation id.')
  return value
}
