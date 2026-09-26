import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useState, type ReactElement, type ReactNode } from 'react'
import { api } from '../lib/api.js'
import { EFFORT_LEVELS, PERMISSION_MODES, SEARCH_PROVIDERS, THINKING_LEVELS, TOOL_LEVELS } from '@protocol'

type ProviderPreset = { id: string; name: string; baseURL: string; wire: string; keyless?: boolean; models: string[]; keyURL?: string }
type StudioConfig = {
  provider: string
  model: string
  providers: Record<string, { name?: string; baseURL: string; wire?: string; keyless?: boolean; keyEnv?: string; headers?: Record<string, string> }>
  memory: { keepSaid?: number; recallLimit?: number; derive?: boolean }
  sessions: { compactAt: number; contextWindow?: number; maxInputTokens: number; keepTurns: number; compaction: boolean }
  display: { tools: 'full' | 'name' | 'off'; thinking: 'on' | 'off' }
  gateways: Record<string, { enabled: boolean; allowlist: string[] }>
  permissions: { mode: 'ask' | 'auto' | 'yolo'; allow: string[]; deny: string[]; jevThreshold: number; jevTimeoutMs: number }
  browser: { enabled: boolean; chromePath: string | null; headless: boolean; profileDir: string | null; cdpUrl: string | null; keepSnapshots: number }
  search?: { provider: 'tavily' | 'exa' | 'parallel'; keyEnv?: string }
  systemPrompt?: string
  maxSteps?: number
  maxTokens?: number
  reasoningEffort: 'low' | 'medium' | 'high'
}
type StudioData = {
  config: StudioConfig
  auth: Record<string, Record<string, { set: boolean; masked?: string }>>
  presets: ProviderPreset[]
  skills: { global: Skill[]; project: Skill[] }
  sessions: Array<{ id: string; title?: string; preview: string; updatedAt: number; messageCount: number }>
  live: { model: string; permissionMode: string; skills: Skill[]; browser: boolean }
}
type Skill = { name: string; description: string; origin?: string; installedAt?: string }

export function Studio({ section, conversationId, onClose, onSessionChange, theme, onThemeChange }: {
  section: string
  conversationId: string
  onClose(): void
  onSessionChange(id: string): void
  theme: string
  onThemeChange(theme: string): void
}) {
  const [data, setData] = useState<StudioData | null>(null)
  const [draft, setDraft] = useState<StudioConfig | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [skillSource, setSkillSource] = useState('')
  const [popular, setPopular] = useState<Array<{ name: string; repo: string; installs?: number; description?: string }>>([])
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api<StudioData>('overview')
      setData(result)
      setDraft(structuredClone(result.config))
      setNotice(null)
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setBusy(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const currentProvider = draft?.provider ?? ''
  const preset = data?.presets.find((item) => item.id === currentProvider)
  const models = preset?.models ?? []
  const saved = data?.config
  const requiresRestart = Boolean(draft && saved && (draft.provider !== saved.provider || draft.model !== saved.model))

  function update(path: string[], value: unknown): void {
    setDraft((current) => {
      if (!current) return current
      const next = structuredClone(current)
      let target: Record<string, unknown> = next
      for (const key of path.slice(0, -1)) {
        const child = target[key]
        if (!child || typeof child !== 'object' || Array.isArray(child)) return current
        target = child as Record<string, unknown>
      }
      target[path[path.length - 1]] = value
      return next
    })
  }

  async function save(): Promise<void> {
    if (!draft) return
    setSaving(true)
    try {
      await api('save-config', { config: draft })
      for (const [slot, value] of Object.entries(secrets)) {
        const [group, id] = slot.split(':')
        await api('save-secret', { group, id, value })
      }
      setSecrets({})
      await load()
      setNotice({ text: requiresRestart ? 'Settings saved. Restart the web server to apply the new provider/model.' : 'Settings saved.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setSaving(false) }
  }

  async function refreshPopular(): Promise<void> {
    try { setPopular(await api('popular-skills')) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function install(source: string): Promise<void> {
    if (!window.confirm(`Install skill instructions from this source?\n\n${source}\n\nRead the skill before trusting it.`)) return
    try {
      await api('install-skill', { source, scope: 'global' })
      await load()
      setNotice({ text: 'Skill installed. Restart Milo to index it in the session.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function remove(name: string, scope: 'global' | 'project'): Promise<void> {
    if (!window.confirm(`Remove the skill “${name}” from ${scope === 'global' ? 'all projects' : 'this project'}?`)) return
    try { await api('remove-skill', { name, scope }); await load(); setNotice({ text: 'Skill removed.', error: false }) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  return <main className="studio-workspace">
    <div className="studio-inner">
      <header className="studio-heading">
        <div><p className="eyebrow">Installation settings</p><h1>{studioTitle(section)}</h1><p>{studioDescription(section)}</p></div>
        <button className="btn-secondary" type="button" onClick={onClose}><span aria-hidden="true">←</span> Back to chat</button>
      </header>
      {busy && <p role="status">Reading Milo’s settings…</p>}
      {!busy && !data && <div className="notice error">{notice?.text ?? 'Could not open Studio.'} <button className="button" type="button" onClick={() => void load()}>Try again</button></div>}
      {data && draft && <>
        {notice && <p className={`notice ${notice.error ? 'error' : 'success'}`} role="status">{notice.text}</p>}
        {requiresRestart && <p className="notice restart-notice" role="status">Provider or model changed. Restart the web server to apply it to the chat.</p>}
        <div className="studio-panel-stack">
        <Section title="Provider & model" description="Choose the service that produces the replies." active={section === 'provider'}>
          <div className="form-grid">
            <Field label="Provider"><select value={draft.provider} onChange={(event) => {
              const next = data.presets.find((item) => item.id === event.target.value)
              update(['provider'], event.target.value)
              if (next) {
                update(['providers', next.id], { name: next.name, baseURL: next.baseURL, wire: next.wire, ...(next.keyless ? { keyless: true } : { keyEnv: `${next.id.toUpperCase()}_API_KEY` }) })
                if (next.models[0]) update(['model'], next.models[0])
              }
            }}>{data.presets.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
            <Field label="Model"><input list="model-options" value={draft.model} onChange={(event) => update(['model'], event.target.value)} /><datalist id="model-options">{models.map((model) => <option key={model} value={model} />)}</datalist><small>Suggestions come from this installation’s provider.</small></Field>
            <Field className="full" label="API URL"><input value={draft.providers?.[currentProvider]?.baseURL ?? ''} onChange={(event) => update(['providers', currentProvider, 'baseURL'], event.target.value)} /></Field>
          </div>
        </Section>
        <Section title="API keys" description="Keys live in Milo’s private file and are never shown again." active={section === 'keys'}>
          {(['providers', 'search', 'gateways'] as const).map((group) => {
            const ids = group === 'providers' ? [...new Set([...data.presets.map((item) => item.id), ...Object.keys(data.auth.providers)])] : group === 'search' ? ['tavily', 'exa', 'parallel'] : ['telegram', 'discord']
            return <div key={group}><h3 className="section-label" style={{ paddingInline: 0 }}>{group === 'providers' ? 'Providers' : group === 'search' ? 'Web search' : 'Gateways'}</h3>
              {ids.map((id) => <div className="secret-row" key={`${group}:${id}`}>
                <span className="secret-name">{id}</span><span className="secret-state">{data.auth[group]?.[id]?.masked ?? 'not set'}</span>
                <input aria-label={`New key for ${id}`} type="password" autoComplete="new-password" value={secrets[`${group}:${id}`] ?? ''} placeholder="New key" onChange={(event) => setSecrets((current) => ({ ...current, [`${group}:${id}`]: event.target.value }))} />
                {data.auth[group]?.[id]?.set && <button className="button danger" type="button" onClick={async () => { await api('remove-secret', { group, id }); await load() }}>Remove</button>}
              </div>)}
            </div>
          })}
        </Section>
        <Section title="Memory" description="What Milo keeps between sessions and how it looks it up later." active={section === 'memory'}>
          <div className="form-grid">
            <Field label="Recent messages kept"><input type="number" min="1" value={draft.memory.keepSaid ?? ''} onChange={(event) => update(['memory', 'keepSaid'], event.target.value ? Number(event.target.value) : undefined)} /><small>Leave empty to use Milo’s default.</small></Field>
            <Field label="Notes used per reply"><input type="number" min="1" value={draft.memory.recallLimit ?? ''} onChange={(event) => update(['memory', 'recallLimit'], event.target.value ? Number(event.target.value) : undefined)} /><small>How many memories enter each question. Empty uses the default.</small></Field>
          </div>
          <label className="check-row"><input type="checkbox" checked={draft.memory.derive !== false} onChange={(event) => update(['memory', 'derive'], event.target.checked)} /> Save facts automatically at the end of each turn</label>
          <p>Semantic search (embeddings) is configured in the <em>milo setup</em> → Memory, where the model is downloaded and run.</p>
        </Section>
        <Section title="Gateways" description="Optional chat channels; tokens are stored locally." active={section === 'gateways'}>
          {(['telegram', 'discord'] as const).map((gateway) => <div key={gateway}>
            <label className="check-row"><input type="checkbox" checked={Boolean(draft.gateways[gateway]?.enabled)} onChange={(event) => update(['gateways', gateway], { enabled: event.target.checked, allowlist: draft.gateways[gateway]?.allowlist ?? [] })} /> Enable {gateway}</label>
            <Field label={`${gateway} · allowed people`}><input value={(draft.gateways[gateway]?.allowlist ?? []).join(', ')} onChange={(event) => update(['gateways', gateway], { enabled: Boolean(draft.gateways[gateway]?.enabled), allowlist: splitNames(event.target.value) })} /><small>Leave empty to allow anyone who finds the bot.</small></Field>
          </div>)}
        </Section>
        <Section title="Tools" description="Optional capabilities Milo can use." active={section === 'tools'}>
          <label className="field"><span>Web search</span><select value={draft.search?.provider ?? 'off'} onChange={(event) => update(['search'], event.target.value === 'off' ? undefined : { provider: event.target.value })}>{SEARCH_PROVIDERS.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="check-row"><input type="checkbox" checked={draft.browser.enabled} onChange={(event) => update(['browser', 'enabled'], event.target.checked)} /> Browser (restart to apply)</label>
          <label className="check-row"><input type="checkbox" checked={draft.browser.headless} onChange={(event) => update(['browser', 'headless'], event.target.checked)} /> Run without a visible window</label>
        </Section>
        <Section title="Permissions" description="The policy applies to tools that can cause effects." active={section === 'permissions'}>
          <div className="form-grid">
            <Field label="Mode"><select value={draft.permissions.mode} onChange={(event) => update(['permissions', 'mode'], event.target.value)}>{PERMISSION_MODES.map((value) => <option key={value}>{value}</option>)}</select></Field>
            <Field label="Reviewer threshold"><input type="number" min="0" max="1" step="0.05" value={draft.permissions.jevThreshold} onChange={(event) => update(['permissions', 'jevThreshold'], Number(event.target.value))} /></Field>
            <Field label="Always-allowed tools"><input value={draft.permissions.allow.join(', ')} onChange={(event) => update(['permissions', 'allow'], splitNames(event.target.value))} /></Field>
            <Field label="Blocked tools"><input value={draft.permissions.deny.join(', ')} onChange={(event) => update(['permissions', 'deny'], splitNames(event.target.value))} /></Field>
          </div>
          <p>“yolo” runs actions without asking for confirmation. Use it only if that is what you want.</p>
        </Section>
        <Section title="Display" description="Choose what shows in the chat and how much the model thinks." active={section === 'display'}>
          <div className="form-grid">
            <Field label="Appearance"><select value={theme} onChange={(event) => onThemeChange(event.target.value)}><option value="system">System theme</option><option value="light">Light theme</option><option value="dark">Dark theme</option></select><small>Applies to this browser only.</small></Field>
            <Field label="Tool detail"><select value={draft.display.tools} onChange={(event) => update(['display', 'tools'], event.target.value)}>{TOOL_LEVELS.map((value) => <option key={value}>{value}</option>)}</select></Field>
            <Field label="Show reasoning"><select value={draft.display.thinking} onChange={(event) => update(['display', 'thinking'], event.target.value)}>{THINKING_LEVELS.map((value) => <option key={value}>{value}</option>)}</select></Field>
            <Field label="Reasoning effort"><select value={draft.reasoningEffort} onChange={(event) => update(['reasoningEffort'], event.target.value)}>{EFFORT_LEVELS.map((value) => <option key={value}>{value}</option>)}</select></Field>
            <Field label="Output limit (tokens)"><input type="number" min="1" value={draft.maxTokens ?? ''} onChange={(event) => update(['maxTokens'], event.target.value ? Number(event.target.value) : undefined)} /></Field>
          </div>
        </Section>
        <Section title="Skills" description="Skills are instructions the model can run. Install only what you have read and trust." active={section === 'skills'}>
          {(['global', 'project'] as const).map((scope) => <div key={scope}>
            <h3 className="section-label" style={{ paddingInline: 0 }}>{scope === 'global' ? 'In this Milo' : 'In this project'}</h3>
            {data.skills[scope].length === 0 ? <p className="list-empty">No skills installed.</p> : data.skills[scope].map((skill) => <div className="skill-row" key={`${scope}-${skill.name}`}><div><div className="secret-name">{skill.name}</div><div className="secret-state">{skill.description}</div></div><span className="secret-state">{skill.origin ?? scope}</span><button className="button danger" type="button" onClick={() => void remove(skill.name, scope)}>Remove</button></div>)}
          </div>)}
          <div className="form-grid" style={{ marginTop: 12 }}><Field className="full" label="Skill source"><input value={skillSource} onChange={(event) => setSkillSource(event.target.value)} placeholder="owner/repo, URL or local folder" /></Field></div>
          <button className="button" type="button" disabled={!skillSource.trim()} onClick={() => void install(skillSource)}>Install skill</button>
          <button className="button" type="button" onClick={() => void refreshPopular()}>Browse popular</button>
          {popular.map((skill) => <div className="skill-row" key={`${skill.repo}-${skill.name}`}><div><div className="secret-name">{skill.name}</div><div className="secret-state">{skill.description ?? skill.repo}</div></div><span className="secret-state">{skill.installs ?? ''}</span><button className="button" type="button" onClick={() => void install(`${skill.repo}/${skill.name}`)}>View / install</button></div>)}
        </Section>
        <Section title="Sessions" description="Saved sessions on this Milo." active={section === 'sessions'}>
          {data.sessions.length === 0 ? <p className="list-empty">No saved sessions yet.</p> : data.sessions.map((session) => <div className="skill-row" key={session.id}><div><div className="secret-name">{session.title || session.preview || session.id}</div><div className="secret-state">{session.preview}</div></div><span className="secret-state">{session.messageCount} msgs</span><button className="button" type="button" onClick={async () => { await api('resume-session', { conversationId, id: session.id }); onSessionChange(session.id) }}>Open</button></div>)}
        </Section>
        </div>
        <div className="studio-save">
          <span className="save-context">Changes apply to this Milo installation.</span>
          <div className="save-actions"><button className="button" type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button></div>
        </div>
      </>}
    </div>
  </main>
}

function Section({ title, description, active = false, children }: { title: string; description: string; active?: boolean; children: ReactNode }) {
  const headingId = `studio-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return <section className="studio-section" hidden={!active} aria-labelledby={headingId}>
    <div className="panel-head"><h2 id={headingId}>{title}</h2><p>{description}</p></div>
    <div className="panel-body">{children}</div>
  </section>
}

function studioTitle(section: string): string {
  return ({ provider: 'Provider & model', keys: 'API keys', memory: 'Memory', gateways: 'Gateways', tools: 'Tools', permissions: 'Permissions', display: 'Display', skills: 'Skills', sessions: 'Sessions' })[section] ?? 'Studio'
}

function studioDescription(section: string): string {
  return ({
    provider: 'Choose the service and the model that produce Milo’s replies.',
    keys: 'Credentials are stored locally and shown masked.',
    memory: 'Adjust how much of the recent messages Milo keeps as memory.',
    gateways: 'Configure the optional chat channels for this installation.',
    tools: 'Turn on the optional capabilities Milo can use.',
    permissions: 'Decide when tools that change the system ask for authorization.',
    display: 'Choose how replies, tools and reasoning appear in the chat.',
    skills: 'Install and manage extra instructions for Milo.',
    sessions: 'Resume saved sessions on this installation.',
  })[section] ?? 'Settings for this installation.'
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const id = useId()
  return <div className={`field ${className}`}>
    <label htmlFor={id}>{label}</label>
    {Children.map(children, (child) => {
      if (!isValidElement(child)) return child
      const type = child.type
      if (type !== 'input' && type !== 'select' && type !== 'textarea') return child
      return cloneElement(child as ReactElement<{ id?: string }>, { id })
    })}
  </div>
}

function splitNames(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
