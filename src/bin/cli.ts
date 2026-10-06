#!/usr/bin/env node
import process from 'node:process'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { render } from 'ink'
import {
  configExists,
  loadConfig,
  readAuth,
  resolveApiKey,
  type LoadedConfig,
} from '../core/config/load.js'
import { errorMessage } from '../util/errors.js'
import { enterMouseTracking, enterTui, exitTui } from '../gateways/cli/ansi.js'
import { mouseStdin } from '../gateways/cli/mouse.js'
import { Shell } from '../gateways/cli/index.js'
import type { PermissionMode } from '../core/tools/permission.js'
import { DEFAULT_WORKING_DIRECTORY } from '../core/config/paths.js'

import { parseArgs, type Args } from './args.js'
import { resolveCommand, resolveInitialMode, validateArgs } from './dispatch.js'

const { version: VERSION } = createRequire(import.meta.url)('../../package.json') as {
  version: string
}

function printHelp(): void {
  console.log(`milo ${VERSION} — a multi-surface agent

Usage:
  milo                       Start the TUI chat
  milo setup                 Configure providers, keys, tools, display, gateways, memory, skills
  milo model                 Choose the provider/model (setup wizard)
  milo skills                Install, list and remove skills (list | available | find | add | remove)
  milo history               What the history log costs (status | trim)
  milo routines              The prompts Milo runs on a timer (list | add | remove | enable | run)
  milo google                Connect a Google account, read-only (connect | status | forget)
  milo mcp                   The external tool servers (list | check | enable | disable)
  milo serve                 Run the enabled bot gateways and the web UI
  milo web                   Run only the web UI (opens the browser)
  milo serve --no-web        Run the bot gateways without the web UI
  milo --continue            Continue the last session in this terminal
  milo --resume <id>         Open a specific session (see /sessions)
  milo --model <id>          Override the model for this session
  milo --provider <id>       Use another configured provider
  milo --mode <mode>         Permission mode: ask | auto | yolo
  milo --yolo                Shorthand for --mode yolo
  milo --web-port <port>     Port for the web UI (default 7717)

In the chat: /model · /setup · /mode ask|auto|yolo · /yolo · /tools full|name|off · /thinking on|off ·
/effort low|medium|high · /new · /sessions · /resume · /stats · /skills · /clear · /help · /exit

Config:  ~/.milo/config.yml
Sessions: ~/.milo/sessions/
Keys:    ~/.milo/auth.json (or env: COMMANDCODE_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, …)`)
}

function applyOverrides(loaded: LoadedConfig, args: Args): void {
  if (args.provider) {
    const entry = loaded.config.providers[args.provider]
    if (!entry) throw new Error(`Provider "${args.provider}" is not configured.`)
    loaded.provider = {
      id: args.provider,
      name: entry.name,
      baseURL: entry.baseURL,
      wire: entry.wire,
      headers: entry.headers,
      apiKey: resolveApiKey(args.provider, entry, readAuth()),
    }
  }
  if (args.model) loaded.model = args.model
}

async function runTui(
  startScreen: 'chat' | 'model' | 'settings',
  standalone: boolean,
  args: Args,
  initialMode?: PermissionMode,
): Promise<void> {
  let loaded: LoadedConfig | null = null
  if (configExists()) {
    loaded = loadConfig()
    if (loaded) applyOverrides(loaded, args)
  }

  const missingKey = loaded !== null && loaded.provider.apiKey === undefined
  const screen = missingKey ? 'model' : startScreen

  enterTui()
  enterMouseTracking()
  try {
    const app = render(
      createElement(Shell, {
        initial: loaded,
        cwd: DEFAULT_WORKING_DIRECTORY,
        startScreen: screen,
        standalone,
        initialMode,
        resumeId: args.resume,
        continueSession: args.continueSession,
      }),
      {
        exitOnCtrlC: false,
        // Without this, Ctrl+Enter arrives as a plain Enter and a message typed
        // mid-turn can only be queued behind it — never steered into it.
        //
        // `enabled`, not `auto`: auto mode asks the terminal with `CSI ? u`, but
        // Ink sends that query from its constructor, while the tty is still in
        // canonical mode — so the reply cannot be read. The detection times out
        // having heard nothing, and the answer then sits in the tty buffer until
        // the first `useInput` turns raw mode on, at which point it reaches the
        // input pipeline and is typed into the composer as `[?0u`. Enabling the
        // protocol outright asks nothing, so there is nothing to leak; a
        // terminal that does not know the sequence ignores it, and Alt+Enter
        // steers there anyway.
        kittyKeyboard: { mode: 'enabled' },
        // The mouse arrives on the same terminal Ink reads, and the wheel is
        // turned into a key there rather than reaching the composer as text.
        stdin: mouseStdin(),
      },
    )
    await app.waitUntilExit()
  } finally {
    exitTui()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.version) {
    console.log(VERSION)
    return
  }
  if (args.help) {
    printHelp()
    return
  }

  const problem = validateArgs(args)
  if (problem) {
    console.error(problem)
    process.exitCode = 1
    return
  }
  const initialMode = resolveInitialMode(args)

  switch (resolveCommand(args.command)) {
    case 'serve': {
      const { runServe } = await import('../gateways/serve.js')
      await runServe({ noWeb: args.noWeb, webPort: args.webPort })
      return
    }
    case 'web': {
      const { runWeb } = await import('./web.js')
      await runWeb(process.argv.slice(2))
      return
    }
    case 'model':
      await runTui('model', true, args, initialMode)
      return
    case 'skills': {
      const { runSkills } = await import('./skills.js')
      process.exitCode = await runSkills(process.argv.slice(2))
      return
    }
    case 'history': {
      const { runHistory } = await import('./history.js')
      process.exitCode = await runHistory(process.argv.slice(2))
      return
    }
    case 'routines': {
      const { runRoutines } = await import('./routines.js')
      process.exitCode = await runRoutines(process.argv.slice(2))
      return
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp.js')
      process.exitCode = await runMcp(process.argv.slice(2))
      return
    }
    case 'google': {
      const { runGoogle } = await import('./google.js')
      process.exitCode = await runGoogle(process.argv.slice(2))
      return
    }
    case 'setup':
      await runTui('settings', true, args, initialMode)
      return
    case 'chat':
      await runTui('chat', false, args, initialMode)
      return
    default:
      console.error(`Unknown command: ${args.command}\n`)
      printHelp()
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
