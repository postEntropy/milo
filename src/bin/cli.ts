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
import { enterAltScreen, exitAltScreen } from '../gateways/cli/ansi.js'
import { Shell } from '../gateways/cli/index.js'
import type { PermissionMode } from '../core/tools/permission.js'

import { parseArgs, type Args } from './args.js'
import { resolveCommand, resolveInitialMode, validateArgs } from './dispatch.js'

const { version: VERSION } = createRequire(import.meta.url)('../../package.json') as {
  version: string
}

function printHelp(): void {
  console.log(`milo ${VERSION} — a multi-surface agent

Usage:
  milo                       Start the TUI chat
  milo setup                 Configure providers, keys, tools, display, gateways, memory
  milo model                 Choose the provider/model (setup wizard)
  milo serve                 Run the enabled bot gateways (Telegram, Discord)
  milo --continue            Continue the last session in this terminal
  milo --resume <id>         Open a specific session (see /sessions)
  milo --model <id>          Override the model for this session
  milo --provider <id>       Use another configured provider
  milo --mode <mode>         Permission mode: ask | auto | yolo
  milo --yolo                Shorthand for --mode yolo

In the chat: /model · /setup · /mode ask|auto|yolo · /yolo · /tools full|name|off · /thinking on|off ·
/new · /sessions · /resume · /stats · /clear · /help · /exit

Config:  ~/.milo/config.json
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

  enterAltScreen()
  try {
    const app = render(
      createElement(Shell, {
        initial: loaded,
        cwd: process.cwd(),
        startScreen: screen,
        standalone,
        initialMode,
        resumeId: args.resume,
      }),
      { exitOnCtrlC: false },
    )
    await app.waitUntilExit()
  } finally {
    exitAltScreen()
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
      await runServe()
      return
    }
    case 'model':
      await runTui('model', true, args, initialMode)
      return
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
