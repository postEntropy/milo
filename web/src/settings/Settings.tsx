import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api.js'
import { formatBytes, formatWhen, message, splitNames } from '../lib/format.js'
import { Field } from '../ui/Form.js'
import { Icon } from '../ui/Icons.js'
import { CLASSIFIER_BACKENDS, EFFORT_LEVELS, PERMISSION_MODES, SEARCH_PROVIDERS, THINKING_LEVELS, TOOL_LEVELS } from '@protocol'
import { GOOGLE_SHORTCUT, GOOGLE_STEPS } from '../../../src/core/google/walkthrough.ts'

type ProviderPreset = { id: string; name: string; baseURL: string; wire: string; keyless?: boolean; models: string[]; keyURL?: string }
type SettingsConfig = {
  provider: string
  model: string
  providers: Record<string, { name?: string; baseURL: string; wire?: string; keyless?: boolean; keyEnv?: string; headers?: Record<string, string> }>
  memory: { keepSaid?: number; recallLimit?: number; derive?: boolean; embedding?: { provider: 'ollama' | 'openrouter'; model?: string; url?: string } }
  sessions: { compactAt: number; contextWindow?: number; maxInputTokens: number; keepTurns: number; compaction: boolean; maxSessions: number }
  display: { tools: 'full' | 'name' | 'off'; thinking: 'on' | 'off' }
  gateways: Record<string, { enabled: boolean; allowlist: string[] }>
  web: { enabled: boolean; host: string; port: number }
  google: { enabled: boolean }
  permissions: { mode: 'ask' | 'auto' | 'yolo'; allow: string[]; deny: string[]; jevThreshold: number; jevTimeoutMs: number }
  classifier: { backend: 'commandcode' | 'ollaya' | 'custom'; model?: string; url?: string; keyEnv?: string; timeoutMs?: number }
  browser: { enabled: boolean; chromePath: string | null; headless: boolean; profileDir: string | null; cdpUrl: string | null; keepSnapshots: number }
  search?: { provider: 'tavily' | 'exa' | 'parallel'; keyEnv?: string }
  systemPrompt?: string
  maxSteps?: number
  maxTokens?: number
  reasoningEffort: 'low' | 'medium' | 'high'
}
type Skill = { name: string; description: string; origin?: string; installedAt?: string }
type MemoryStats = { backend: string; location: string; scopes: number; facts: number; bytes: number }
type Note = { id: string; text: string; createdAt: number; tags?: string[] }
type Browser = { id: string; name: string; path: string; version: string | null }
type Profile = { id: string; name: string; dir: string; bytes: number }
/** The three states the server reports for the grant, with the tools it buys. */
type GoogleReport = (
  | { kind: 'off' }
  | { kind: 'wanted' }
  | { kind: 'connected'; email?: string; connectedAt?: string; enabled: boolean }
) & { tools: string[] }

type SettingsData = {
  config: SettingsConfig
  auth: Record<string, Record<string, { set: boolean; masked?: string }>>
  presets: ProviderPreset[]
  skills: { global: Skill[]; project: Skill[] }
  sessions: Array<{ id: string; title?: string; preview: string; updatedAt: number; messageCount: number }>
  memoryStats: MemoryStats
  live: { model: string; effort: string; permissionMode: string; skills: Skill[]; browser: boolean }
  google: GoogleReport
}
type JobView = { id: string; kind: string; status: 'running' | 'done' | 'error'; lines: string[]; result?: Record<string, unknown>; error?: string }
type Notice = { text: string; error: boolean }

export function Settings({ section, conversationId, sessionId, onClose, onSessionChange, theme, onThemeChange }: {
  section: string
  conversationId: string
  sessionId: string
  onClose(): void
  onSessionChange(id: string): void
  theme: string
  onThemeChange(theme: string): void
}) {
  const [data, setData] = useState<SettingsData | null>(null)
  const [draft, setDraft] = useState<SettingsConfig | null>(null)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [skillSource, setSkillSource] = useState('')
  const [skillScope, setSkillScope] = useState<'global' | 'project'>('global')
  const [skillChoice, setSkillChoice] = useState<string[] | null>(null)
  const [popular, setPopular] = useState<Array<{ name: string; repo: string; installs?: number; description?: string }>>([])
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [browsers, setBrowsers] = useState<Browser[] | null>(null)
  const [profiles, setProfiles] = useState<Profile[] | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    try {
      const result = await api<SettingsData>('overview')
      setData(result)
      setDraft(structuredClone(result.config))
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await api<SettingsData>('overview')
      setData(result)
      setDraft(structuredClone(result.config))
      setNotice(null)
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setBusy(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const job = useJob(() => { void reload() })

  const refreshNotes = useCallback(async (): Promise<void> => {
    try { setNotes((await api<{ notes: Note[] }>('memory-notes')).notes) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }, [])

  useEffect(() => { if (section === 'memory') void refreshNotes() }, [section, refreshNotes])

  const currentProvider = draft?.provider ?? ''
  const preset = data?.presets.find((item) => item.id === currentProvider)
  const models = preset?.models ?? []
  const saved = data?.config
  const requiresRestart = Boolean(draft && saved && (
    draft.provider !== saved.provider || draft.model !== saved.model ||
    JSON.stringify(draft.browser) !== JSON.stringify(saved.browser) ||
    JSON.stringify(draft.web) !== JSON.stringify(saved.web) ||
    // The reviewer is built once at startup, so which decision model it asks is
    // read on the next run, like the browser and the web host.
    JSON.stringify(draft.classifier) !== JSON.stringify(saved.classifier) ||
    // The Google tools are registered when the runtime starts, so switching them
    // on here is read on the next run too.
    JSON.stringify(draft.google) !== JSON.stringify(saved.google)
  ))

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
      setNotice({ text: requiresRestart ? 'Settings saved. Restart the web server to apply the provider, model, browser or classifier.' : 'Settings saved.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setSaving(false) }
  }

  /** Writes the config straight away, for a control that acts rather than edits. */
  async function saveNow(patch: (config: SettingsConfig) => void, note: string): Promise<void> {
    if (!draft) return
    setSaving(true)
    try {
      const next = structuredClone(draft)
      patch(next)
      await api('save-config', { config: next })
      await reload()
      setNotice({ text: note, error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
    finally { setSaving(false) }
  }

  async function refreshPopular(): Promise<void> {
    try { setPopular(await api('popular-skills')) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function install(source: string, skill?: string): Promise<void> {
    if (!skill && !window.confirm(`Install skill instructions from this source?\n\n${source}\n\nRead the skill before trusting it.`)) return
    try {
      const result = await api<{ needChoice?: string[] }>('install-skill', { source, scope: skillScope, skill })
      if (result.needChoice) {
        setSkillChoice(result.needChoice)
        setNotice({ text: 'That source holds several skills — pick one.', error: false })
        return
      }
      setSkillChoice(null)
      setSkillSource('')
      await load()
      setNotice({ text: 'Skill installed. Restart Milo to index it in the session.', error: false })
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function remove(name: string, scope: 'global' | 'project'): Promise<void> {
    if (!window.confirm(`Remove the skill “${name}” from ${scope === 'global' ? 'all projects' : 'this project'}?`)) return
    try { await api('remove-skill', { name, scope }); await load(); setNotice({ text: 'Skill removed.', error: false }) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function forgetNote(id: string): Promise<void> {
    try { await api('forget-note', { id }); await refreshNotes() }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function startJob(kind: string, body: Record<string, unknown> = {}): Promise<void> {
    job.clear()
    try { await job.run(kind, body) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function exportSession(id: string): Promise<void> {
    try {
      const result = await api<{ path: string } | null>('export', { id, format: 'md' })
      setNotice(result ? { text: `Exported to ${result.path}`, error: false } : { text: 'Nothing to export — this session has no log.', error: true })
    } catch (error) { setNotice({ text: message(error), error: true }) }
  }

  async function deleteSession(id: string): Promise<void> {
    if (!window.confirm('Delete this session permanently? The history log keeps its record, but it disappears from the session list.')) return
    try { await api('session-delete', { id, current: sessionId }); await load(); setNotice({ text: 'Session deleted.', error: false }) }
    catch (error) { setNotice({ text: message(error), error: true }) }
  }

  return <main className="settings-workspace">
    <div className="settings-inner">
      {busy && <p role="status">Reading Milo’s settings…</p>}
      {!busy && !data && <div className="notice error">{notice?.text ?? 'Could not open settings.'} <button className="button" type="button" onClick={() => void load()}>Try again</button></div>}
      {data && draft && <>
        {notice && <p className={`notice ${notice.error ? 'error' : 'success'}`} role="status">{notice.text}</p>}
        {job.job && <JobLog job={job.job} onClose={() => job.clear()} />}
        {requiresRestart && <p className="notice restart-notice" role="status">Saved changes need a restart of the web server to reach the chat.</p>}
        <div className="settings-panel-stack">
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
        <Section title="Memory" description="What Milo keeps between sessions, and how it looks it up later." active={section === 'memory'}>
          <div className="form-grid">
            <Field label="Recent messages kept"><input type="number" min="1" value={draft.memory.keepSaid ?? ''} onChange={(event) => update(['memory', 'keepSaid'], event.target.value ? Number(event.target.value) : undefined)} /><small>Leave empty to use Milo’s default.</small></Field>
            <Field label="Notes used per reply"><input type="number" min="1" value={draft.memory.recallLimit ?? ''} onChange={(event) => update(['memory', 'recallLimit'], event.target.value ? Number(event.target.value) : undefined)} /><small>How many memories enter each question. Empty uses the default.</small></Field>
          </div>
          <label className="check-row"><input type="checkbox" checked={draft.memory.derive !== false} onChange={(event) => update(['memory', 'derive'], event.target.checked)} /> Save facts automatically at the end of each turn</label>

          <h3 className="section-label" style={{ paddingInline: 0 }}>Recall by meaning</h3>
          <p className="panel-note">
            {draft.memory.embedding
              ? `On — ${draft.memory.embedding.provider === 'ollama' ? 'on this machine' : 'on OpenRouter'}${draft.memory.embedding.model ? ` (${draft.memory.embedding.model})` : ''}. Restart to apply.`
              : 'Off — recall matches words only.'}
          </p>
          <div className="button-row">
            <button className="button" type="button" disabled={saving} onClick={() => void startJob('embed-provision')}><Icon name="download" size={14} /> Use this machine</button>
            <button className="button" type="button" disabled={saving} onClick={() => void saveNow((config) => { config.memory.embedding = { provider: 'openrouter' } }, 'Embeddings set to OpenRouter — it uses the OpenRouter key from API keys. Restart to apply.')}>Use OpenRouter</button>
            <button className="button danger" type="button" disabled={saving || !draft.memory.embedding} onClick={() => void saveNow((config) => { delete config.memory.embedding }, 'Embeddings off. Restart to apply.')}>Turn off</button>
          </div>
          <p className="panel-note">Local embeddings download the engine (~1.9 GB) and a model, and run on this machine; nothing leaves it. OpenRouter sends the notes off the machine.</p>

          <h3 className="section-label" style={{ paddingInline: 0 }}>Notes</h3>
          {data.memoryStats && <p className="panel-note">{data.memoryStats.facts} fact{data.memoryStats.facts === 1 ? '' : 's'} · {formatBytes(data.memoryStats.bytes)} · {data.memoryStats.location}</p>}
          {notes === null ? <p className="list-empty">Reading…</p>
            : notes.length === 0 ? <p className="list-empty">Nothing is remembered yet.</p>
            : notes.map((note) => <div className="entry-row" key={note.id}><div><div className="secret-name">{note.text}</div><div className="secret-state">{formatWhen(note.createdAt)} · {note.id.slice(0, 8)}</div></div><button className="button danger" type="button" onClick={() => void forgetNote(note.id)}>Forget</button></div>)}
        </Section>
        <Section title="Gateways" description="Optional chat channels; tokens are stored locally." active={section === 'gateways'}>
          {(['telegram', 'discord'] as const).map((gateway) => <div key={gateway}>
            <label className="check-row"><input type="checkbox" checked={Boolean(draft.gateways[gateway]?.enabled)} onChange={(event) => update(['gateways', gateway], { enabled: event.target.checked, allowlist: draft.gateways[gateway]?.allowlist ?? [] })} /> Enable {gateway}</label>
            <Field label={`${gateway} · allowed people`}><input value={(draft.gateways[gateway]?.allowlist ?? []).join(', ')} onChange={(event) => update(['gateways', gateway], { enabled: Boolean(draft.gateways[gateway]?.enabled), allowlist: splitNames(event.target.value) })} /><small>Leave empty to allow anyone who finds the bot.</small></Field>
          </div>)}
        </Section>
        <Section title="Web" description="The browser chat: whether it is served, and where it listens." active={section === 'web'}>
          <label className="check-row"><input type="checkbox" checked={draft.web.enabled} onChange={(event) => update(['web', 'enabled'], event.target.checked)} /> Serve it with <code className="mono">milo serve</code> (restart to apply)</label>
          <div className="form-grid">
            <Field label="Bind address"><input value={draft.web.host} onChange={(event) => update(['web', 'host'], event.target.value)} placeholder="127.0.0.1" /></Field>
            <Field label="Port"><input type="number" min="0" max="65535" value={draft.web.port} onChange={(event) => update(['web', 'port'], Number(event.target.value))} /></Field>
          </div>
          <p className="panel-note">Both are read when <code className="mono">milo serve</code> starts, and the URL it prints carries the token that authorizes the page. <code className="mono">milo web</code> runs this screen alone, with <code className="mono">--host</code> and <code className="mono">--port</code> overriding them for one run.</p>
          <p className="panel-note">Anything but loopback is reachable from the network, and that token is then the only thing between a stranger and this install.</p>
        </Section>
        <Section title="Tools" description="Optional capabilities Milo can use." active={section === 'tools'}>
          <label className="field"><span>Web search</span><select value={draft.search?.provider ?? 'off'} onChange={(event) => update(['search'], event.target.value === 'off' ? undefined : { provider: event.target.value })}>{SEARCH_PROVIDERS.map((value) => <option key={value}>{value}</option>)}</select></label>

          <h3 className="section-label" style={{ paddingInline: 0 }}>Google</h3>
          {data?.google.kind === 'connected' ? (
            <p className="panel-note">
              Connected as <code className="mono">{data.google.email ?? 'an account Gmail would not name'}</code>
              {data.google.connectedAt ? ` since ${data.google.connectedAt.slice(0, 10)}` : ''}. Read-only:{' '}
              {data.google.tools.join(', ')}.
            </p>
          ) : data?.google.kind === 'wanted' ? (
            <p className="panel-note">
              The tools are on in the config, but no account has been allowed yet. Run{' '}
              <code className="mono">milo google connect</code> on the machine Milo runs on — it walks
              these steps and opens the browser there:
            </p>
          ) : (
            <p className="panel-note">The connection is yours: you make an app in Google&rsquo;s console, once, and allow it on this machine. Milo keeps read access only — it can never write to your mail or your files.</p>
          )}
          <label className="check-row"><input type="checkbox" checked={draft.google.enabled} onChange={(event) => update(['google', 'enabled'], event.target.checked)} /> Read Gmail and Drive (restart to apply)</label>
          {data?.google.kind === 'connected' ? (
            <p className="panel-note">
              To disconnect, run <code className="mono">milo google forget</code> on the machine Milo
              runs on.
            </p>
          ) : (
            <>
              <ol className="panel-note">
                {GOOGLE_STEPS.map((step) => (
                  <li key={step.what}>
                    {step.url ? <a href={step.url} target="_blank" rel="noreferrer">{step.what}</a> : step.what}
                    {step.why ? ` — ${step.why}` : ''}
                  </li>
                ))}
              </ol>
              <p className="panel-note">Then run <code className="mono">milo google connect</code> on the machine Milo runs on. It walks the same steps and prints those links. The shortcut at <a href={GOOGLE_SHORTCUT} target="_blank" rel="noreferrer">Google&rsquo;s Workspace guide</a> creates the project, enables the APIs and downloads a <code className="mono">credentials.json</code>, which <code className="mono">--credentials</code> takes.</p>
            </>
          )}

          <h3 className="section-label" style={{ paddingInline: 0 }}>Browser</h3>
          <label className="check-row"><input type="checkbox" checked={draft.browser.enabled} onChange={(event) => update(['browser', 'enabled'], event.target.checked)} /> Enable the browser (restart to apply)</label>
          <label className="check-row"><input type="checkbox" checked={draft.browser.headless} onChange={(event) => update(['browser', 'headless'], event.target.checked)} /> Run without a visible window</label>
          <div className="form-grid">
            <Field className="full" label="Browser binary"><input value={draft.browser.chromePath ?? ''} onChange={(event) => update(['browser', 'chromePath'], event.target.value || null)} placeholder="auto — the first one found" /></Field>
            <Field className="full" label="Profile directory"><input value={draft.browser.profileDir ?? ''} onChange={(event) => update(['browser', 'profileDir'], event.target.value || null)} placeholder="its own profile" /></Field>
            <Field label="Attach to (CDP URL)"><input value={draft.browser.cdpUrl ?? ''} onChange={(event) => update(['browser', 'cdpUrl'], event.target.value || null)} placeholder="host:port" /></Field>
            <Field label="Page snapshots kept"><input type="number" min="0" value={draft.browser.keepSnapshots} onChange={(event) => update(['browser', 'keepSnapshots'], Number(event.target.value))} /></Field>
          </div>
          <div className="button-row">
            <button className="button" type="button" onClick={async () => { try { setBrowsers(await api('browsers')) } catch (error) { setNotice({ text: message(error), error: true }) } }}>Find browsers</button>
            <button className="button" type="button" disabled={saving} onClick={() => void startJob('browser-install')}><Icon name="download" size={14} /> Download Chrome for Testing</button>
            <button className="button" type="button" onClick={async () => { try { setProfiles(await api('profiles')) } catch (error) { setNotice({ text: message(error), error: true }) } }}>Find profiles</button>
          </div>
          {browsers && (browsers.length === 0 ? <p className="list-empty">No browser found on this machine.</p> : browsers.map((browser) => <div className="entry-row" key={browser.path}>
            <div><div className="secret-name">{browser.name}{browser.version ? ` · ${browser.version}` : ''}</div><div className="secret-state">{browser.path}</div></div>
            <button className="button" type="button" onClick={() => { update(['browser', 'chromePath'], browser.path); setNotice({ text: 'Browser chosen — Save changes to keep it.', error: false }) }}>Use</button>
          </div>))}
          {profiles && (profiles.length === 0 ? <p className="list-empty">No profile found to copy.</p> : profiles.map((profile) => <div className="entry-row" key={profile.dir}>
            <div><div className="secret-name">{profile.name}</div><div className="secret-state">{profile.dir} · {formatBytes(profile.bytes)}</div></div>
            <button className="button" type="button" disabled={saving} onClick={() => void startJob('profile-copy', { id: profile.id, dir: profile.dir })}>Copy and use</button>
          </div>))}
          <p className="panel-note">Copying a profile carries the sign-in from the browser you use, so Milo then acts as you on those sites. Close that browser first — a profile in use cannot be copied.</p>
        </Section>
        <Section title="Permissions" description="The policy applies to tools that can cause effects." active={section === 'permissions'}>
          <div className="form-grid">
            <Field label="Mode"><select value={draft.permissions.mode} onChange={(event) => update(['permissions', 'mode'], event.target.value)}>{PERMISSION_MODES.map((value) => <option key={value}>{value}</option>)}</select></Field>
            <Field label="Reviewer threshold"><input type="number" min="0" max="1" step="0.05" value={draft.permissions.jevThreshold} onChange={(event) => update(['permissions', 'jevThreshold'], Number(event.target.value))} /></Field>
            <Field label="Always-allowed tools"><input value={draft.permissions.allow.join(', ')} onChange={(event) => update(['permissions', 'allow'], splitNames(event.target.value))} /></Field>
            <Field label="Blocked tools"><input value={draft.permissions.deny.join(', ')} onChange={(event) => update(['permissions', 'deny'], splitNames(event.target.value))} /></Field>
            <Field label="Classifier backend"><select value={draft.classifier.backend} onChange={(event) => update(['classifier', 'backend'], event.target.value)}>{CLASSIFIER_BACKENDS.map((value) => <option key={value}>{value}</option>)}</select><small>Hosted jev rides on the chat provider; a local Ollaya or a custom endpoint stands on its own. Applies on the next start.</small></Field>
            <Field label="Classifier model"><input value={draft.classifier.model ?? ''} placeholder="backend default" onChange={(event) => update(['classifier', 'model'], event.target.value || undefined)} /></Field>
            <Field label="Classifier URL"><input value={draft.classifier.url ?? ''} placeholder="backend default" onChange={(event) => update(['classifier', 'url'], event.target.value || undefined)} /></Field>
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
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="Install into"><select value={skillScope} onChange={(event) => setSkillScope(event.target.value as 'global' | 'project')}><option value="global">Every project</option><option value="project">This project</option></select></Field>
            <Field label="Skill source"><input value={skillSource} onChange={(event) => { setSkillSource(event.target.value); setSkillChoice(null) }} placeholder="owner/repo, URL or local folder" /></Field>
          </div>
          <button className="button" type="button" disabled={!skillSource.trim()} onClick={() => void install(skillSource)}>Install skill</button>
          <button className="button" type="button" onClick={() => void refreshPopular()}>Browse popular</button>
          {skillChoice && <div className="button-row">{skillChoice.map((name) => <button className="button" type="button" key={name} onClick={() => void install(skillSource, name)}>Install {name}</button>)}</div>}
          {popular.map((skill) => <div className="skill-row" key={`${skill.repo}-${skill.name}`}><div><div className="secret-name">{skill.name}</div><div className="secret-state">{skill.description ?? skill.repo}</div></div><span className="secret-state">{skill.installs ?? ''}</span><button className="button" type="button" onClick={() => void install(`${skill.repo}/${skill.name}`)}>View / install</button></div>)}
        </Section>
        <Section title="Sessions" description="Saved sessions, and how the transcript is kept." active={section === 'sessions'}>
          <div className="form-grid">
            <Field label="Compact when the context is (%)"><input type="number" min="1" max="100" value={Math.round(draft.sessions.compactAt * 100)} onChange={(event) => update(['sessions', 'compactAt'], Number(event.target.value) / 100)} /><small>Share of the model’s window that triggers a fold.</small></Field>
            <Field label="Turns kept verbatim"><input type="number" min="1" value={draft.sessions.keepTurns} onChange={(event) => update(['sessions', 'keepTurns'], Number(event.target.value))} /></Field>
            <Field label="Fallback budget (tokens)"><input type="number" min="1024" value={draft.sessions.maxInputTokens} onChange={(event) => update(['sessions', 'maxInputTokens'], Number(event.target.value))} /><small>Used only when the model’s window is unknown.</small></Field>
            <Field label="Context window (tokens)"><input type="number" min="1024" value={draft.sessions.contextWindow ?? ''} onChange={(event) => update(['sessions', 'contextWindow'], event.target.value ? Number(event.target.value) : undefined)} /><small>Overrides the catalog, for a model it does not know.</small></Field>
            <Field label="Sessions kept"><input type="number" min="1" value={draft.sessions.maxSessions} onChange={(event) => update(['sessions', 'maxSessions'], Number(event.target.value))} /></Field>
          </div>
          <label className="check-row"><input type="checkbox" checked={draft.sessions.compaction} onChange={(event) => update(['sessions', 'compaction'], event.target.checked)} /> Compact long sessions automatically</label>

          <h3 className="section-label" style={{ paddingInline: 0 }}>Saved sessions</h3>
          {data.sessions.length === 0 ? <p className="list-empty">No saved sessions yet.</p> : data.sessions.map((session) => <div className="entry-row" key={session.id}>
            <div><div className="secret-name">{session.title || session.preview || session.id}{session.id === sessionId ? ' · current' : ''}</div><div className="secret-state">{session.preview} · {session.messageCount} msgs · {formatWhen(session.updatedAt)}</div></div>
            <div className="row-actions">
              <button className="button" type="button" onClick={async () => { await api('resume-session', { conversationId, id: session.id }); onSessionChange(session.id) }}>Open</button>
              <button className="button" type="button" onClick={() => void exportSession(session.id)}><Icon name="download" size={13} /></button>
              {session.id === sessionId
                ? <button className="button" type="button" onClick={async () => { await api('clear-session', { conversationId }); await load(); setNotice({ text: 'Conversation cleared.', error: false }) }}>Clear</button>
                : <button className="button danger" type="button" onClick={() => void deleteSession(session.id)}><Icon name="trash" size={13} /></button>}
            </div>
          </div>)}
        </Section>
        </div>
        <div className="settings-save">
          <span className="save-context">Changes apply to this Milo installation.</span>
          <div className="save-actions"><button className="button" type="button" onClick={onClose}>Cancel</button>
          <button className="button primary" type="button" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</button></div>
        </div>
      </>}
    </div>
  </main>
}

function Section({ title, description, active = false, children }: { title: string; description: string; active?: boolean; children: ReactNode }) {
  const headingId = `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return <section className="settings-section" hidden={!active} aria-labelledby={headingId}>
    <div className="panel-head"><h2 id={headingId}>{title}</h2><p>{description}</p></div>
    <div className="panel-body">{children}</div>
  </section>
}

function JobLog({ job, onClose }: { job: JobView; onClose(): void }) {
  return <div className={`job-panel ${job.status}`} role="status">
    <div className="job-head">
      <span>{job.status === 'running' ? `${job.status} · ${jobLabel(job.kind)}` : job.status === 'done' ? `${jobLabel(job.kind)} — done` : `${jobLabel(job.kind)} — failed`}</span>
      <button className="icon-button" type="button" aria-label="Dismiss" onClick={onClose}><Icon name="x" size={14} /></button>
    </div>
    {job.error && <p className="job-error">{job.error}</p>}
    {job.status === 'done' && job.result?.restart === true && <p className="panel-note">Saved to the config. Restart the web server to apply it.</p>}
    <pre className="job-log">{job.lines.join('\n') || (job.status === 'running' ? 'Working…' : '(no output)')}</pre>
  </div>
}

/** Polls a long-running setup job until it ends. */
function useJob(onFinished: () => void): { job: JobView | null; run(kind: string, body: Record<string, unknown>): Promise<void>; clear(): void } {
  const [job, setJob] = useState<JobView | null>(null)
  const timer = useRef<number | null>(null)
  const stop = useCallback(() => {
    if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null }
  }, [])
  useEffect(() => stop, [stop])

  const run = useCallback(async (kind: string, body: Record<string, unknown>): Promise<void> => {
    stop()
    const started = await api<{ id: string }>('job-start', { kind, ...body })
    setJob({ id: started.id, kind, status: 'running', lines: [] })
    timer.current = window.setInterval(() => {
      void api<JobView>('job-status', { id: started.id }).then((view) => {
        setJob(view)
        if (view.status !== 'running') { stop(); onFinished() }
      }).catch(() => undefined)
    }, 700)
  }, [onFinished, stop])

  return { job, run, clear: () => { stop(); setJob(null) } }
}

function jobLabel(kind: string): string {
  return ({ 'browser-install': 'Chrome for Testing', 'profile-copy': 'Copying a profile', 'embed-provision': 'The embedding engine' })[kind] ?? kind
}

