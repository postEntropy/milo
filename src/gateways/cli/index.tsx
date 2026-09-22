import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useApp } from 'ink'
import Spinner from 'ink-spinner'
import { createRuntime } from '../../core/bootstrap.js'
import { loadConfig, setPermissionMode, type LoadedConfig } from '../../core/config/load.js'
import { MILO_HOME } from '../../core/config/paths.js'
import type { MemoryScope } from '../../core/memory/index.js'
import type { PermissionMode } from '../../core/tools/permission.js'
import { ChatScreen } from './screens/chat.js'
import { ModelPicker } from './screens/model-picker.js'
import { SettingsScreen } from './screens/settings.js'
import { theme } from './theme.js'
import { useTerminalSize } from './use-terminal-size.js'
import type { Item } from './transcript.js'

type Screen = 'setup' | 'chat' | 'model' | 'settings'

const CLI_SCOPE: MemoryScope = { gateway: 'cli', conversationId: 'main' }

export interface ShellProps {
  initial: LoadedConfig | null
  cwd: string
  startScreen?: 'chat' | 'model' | 'settings'
  standalone?: boolean
  initialMode?: PermissionMode
  /** `milo --resume <id>`: open this session instead of the last one bound here. */
  resumeId?: string
}

export function Shell({
  initial,
  cwd,
  startScreen = 'chat',
  standalone = false,
  initialMode,
  resumeId,
}: ShellProps) {
  const { exit } = useApp()
  const { rows, columns } = useTerminalSize()

  const [loaded, setLoaded] = useState<LoadedConfig | null>(initial)
  const [screen, setScreen] = useState<Screen>(() => (initial ? startScreen : 'setup'))
  const [busy, setBusy] = useState(false)
  const [items, setItems] = useState<Item[]>([])

  // Rebuild the runtime only when the provider/model changes, so editing
  // settings keeps the current conversation and its context.
  const runtimeKey = loaded ? `${loaded.provider.id}:${loaded.model}` : null
  const runtime = useMemo(
    () => (loaded ? createRuntime(loaded, cwd) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtimeKey, cwd],
  )

  const [mode, setMode] = useState<PermissionMode>(
    () => initialMode ?? runtime?.permissions?.mode ?? 'ask',
  )

  // The session bound to this terminal, resolved once the runtime exists.
  const [sessionId, setSessionId] = useState<string | null>(null)
  // `--resume` applies once: rebuilding the runtime (a model change) must not
  // yank the user back to the session they asked for at startup.
  const resumed = useRef(false)
  useEffect(() => {
    if (!runtime) return
    let cancelled = false
    const resolve = async () => {
      if (resumeId && !resumed.current) {
        resumed.current = true
        const target = await runtime.resumeSession(CLI_SCOPE, resumeId)
        if (target) {
          if (!cancelled) setSessionId(target.id)
          return
        }
        if (!cancelled) {
          setItems((previous) => [
            ...previous,
            { kind: 'info', text: `No session "${resumeId}" — continuing the last one.` },
          ])
        }
      }
      const session = await runtime.getSession(CLI_SCOPE)
      if (!cancelled) setSessionId(session.id)
    }
    void resolve()
    return () => {
      cancelled = true
    }
  }, [runtime, resumeId])

  // Push live settings edits into the existing policy.
  useEffect(() => {
    if (!runtime?.permissions || !loaded) return
    runtime.permissions.update({
      mode,
      allow: loaded.config.permissions.allow,
      deny: loaded.config.permissions.deny,
      threshold: loaded.config.permissions.jevThreshold,
    })
  }, [runtime, loaded, mode])

  const previousKey = useRef(runtimeKey)
  useEffect(() => {
    if (previousKey.current !== runtimeKey) {
      setItems([])
      previousKey.current = runtimeKey
    }
  }, [runtimeKey])

  // Set when a screen writes to disk, so leaving setup can say so.
  const wroteSettings = useRef(false)

  const changeMode = (next: PermissionMode) => {
    setMode(next)
    runtime?.permissions?.setMode(next)
    // One value for every surface, written down so it outlives this process.
    setPermissionMode(next)
    wroteSettings.current = true
    setLoaded((current) =>
      current
        ? {
            ...current,
            config: {
              ...current.config,
              permissions: { ...current.config.permissions, mode: next },
            },
          }
        : current,
    )
  }

  const reload = () => {
    wroteSettings.current = true
    setLoaded(loadConfig())
  }

  const afterSave = () => {
    setLoaded(loadConfig())
    setBusy(false)
    // `milo setup` finishes the wizard and continues into the settings hub;
    // `milo model` is done once a model is picked, and a plain `milo` goes
    // straight to the chat.
    if (startScreen === 'settings') setScreen('settings')
    else if (standalone) exit()
    else setScreen('chat')
  }

  const cancel = () => {
    if (standalone || !loaded) exit()
    else setScreen('chat')
  }

  const closeSettings = () => {
    if (wroteSettings.current) {
      wroteSettings.current = false
      setItems((previous) => [
        ...previous,
        { kind: 'info', text: `settings saved · ${MILO_HOME}` },
      ])
    }
    if (standalone) exit()
    else setScreen('chat')
  }

  const openModel = () => {
    setBusy(false)
    setScreen('model')
  }

  const headerRight = loaded
    ? `${sessionId ? `${sessionId} · ` : ''}${loaded.provider.id} · ${loaded.model}`
    : 'setup'
  const accent = busy ? theme.warning : theme.accent

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box borderStyle="round" borderColor={accent} paddingX={1} justifyContent="space-between">
        <Box>
          {busy && (
            <Text color={theme.warning}>
              <Spinner type="dots" />{' '}
            </Text>
          )}
          <Text bold color={accent}>
            Milo
          </Text>
          {mode !== 'ask' && (
            <Text bold color={mode === 'yolo' ? theme.danger : theme.warning}>
              {' '}
              [{mode}]
            </Text>
          )}
        </Box>
        <Text dimColor>{headerRight}</Text>
      </Box>

      {screen === 'chat' && runtime ? (
        <ChatScreen
          runtime={runtime}
          scope={CLI_SCOPE}
          mode={mode}
          onModeChange={changeMode}
          items={items}
          setItems={setItems}
          onOpenModel={openModel}
          onOpenSettings={() => setScreen('settings')}
          onExit={exit}
          onBusyChange={setBusy}
          onSessionChange={setSessionId}
        />
      ) : screen === 'settings' && loaded ? (
        <SettingsScreen
          config={loaded.config}
          mode={mode}
          onModeChange={changeMode}
          onOpenModel={openModel}
          onSaved={reload}
          onClose={closeSettings}
        />
      ) : (
        <ModelPicker
          current={loaded ? { provider: loaded.provider.id, model: loaded.model } : undefined}
          onDone={afterSave}
          onCancel={cancel}
        />
      )}
    </Box>
  )
}
