#!/usr/bin/env node
import process from 'node:process'
import { statSync } from 'node:fs'
import { createElement } from 'react'
import { render } from 'ink'
import { configExists, loadConfig, type LoadedConfig } from '../core/config/load.js'
import { formatInstallVersion, readInstallVersion } from '../core/version.js'
import { errorMessage } from '../util/errors.js'
import { enterBracketedPaste, enterMouseTracking, enterTui, exitTui } from '../gateways/cli/ansi.js'
import { mouseStdin } from '../gateways/cli/mouse.js'
import { Shell } from '../gateways/cli/index.js'
import type { PermissionMode } from '../core/tools/permission.js'
import { DEFAULT_WORKING_DIRECTORY } from '../core/config/paths.js'
import { resolveProjectRef } from '../core/projects.js'
import { resolveToolPath } from '../core/tools/walk.js'

import { parseArgs, type Args } from './args.js'
import { isResourceCommand, resolveCommand, resolveInitialMode, SERVE_USAGE, validateArgs } from './dispatch.js'
import { applyOverrides } from './overrides.js'

function installVersionLine(): string {
  return formatInstallVersion(readInstallVersion())
}

function printHelp(): void {
  console.log(`milo ${installVersionLine()} — a multi-surface agent

Usage:
  milo                       Start the TUI chat
  milo setup                 Configure providers, keys, tools, display, gateways, memory, skills
  milo model                 Choose the provider/model (setup wizard)
  milo skills                Install, list and remove skills (list | available | find | add | remove)
  milo history               What the history log costs (status | trim)
  milo log                   What the execution log holds (status | tail | follow | trim)
  milo routines              The prompts Milo runs on a timer (list | add | remove | enable | run)
  milo projects              The folders a session may work in (list | add | rename | move | remove)
  milo google                Connect a Google account (connect | status | forget)
  milo chatgpt               Sign in with a ChatGPT (Codex) subscription (login | status | logout)
  milo pair                  Let a phone in: prints a one-time code and the address to give
  milo devices               The devices paired with this Milo (list | revoke)
  milo mcp                   The external tool servers (list | check | enable | disable)
  milo version               Print the installed version and git commit
  milo update                Pull commits from GitHub and rebuild (--check | --branch | --to | --force)
  milo export [path]         Export this Milo installation (~/.milo) to a .tar.gz archive
  milo import <archive>      Restore a Milo installation from an exported archive (--dry-run | --yes)
  milo serve                 Run the enabled bot gateways and the web UI
  milo web                   Run only the web UI (opens the browser)
  milo spotlight             Milo in a desktop popup, a keystroke away
  milo serve --no-web        Run the bot gateways without the web UI
  milo run "prompt"          One turn, no UI: the answer on stdout, JSON with --json
  milo run --project <ref> "prompt"   Run in a registered project's folder
  milo --continue            Continue the last session in this terminal
  milo --resume <id>         Open a specific session (see /sessions)
  milo --project <ref>       Work in a registered project, by id, name or folder
  milo --cwd <folder>        Work in a folder as it is
  milo --model <id>          Override the model for this session
  milo --provider <id>       Use another configured provider
  milo --mode <mode>         Permission mode: ask | auto | yolo
  milo --yolo                Shorthand for --mode yolo
  milo --web-port <port>     Port for the web UI (default 7717)

In the chat: /model · /setup · /mode ask|auto|yolo · /yolo · /tools full|name|off · /thinking expanded|collapsed ·
/effort low|medium|high · /new · /sessions · /resume · /stats · /skills · /clear · /help · /exit

Config:  ~/.milo/config.yml
Sessions: ~/.milo/sessions/
Keys:    ~/.milo/auth.json (or env: COMMANDCODE_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, …)`)
}

async function runTui(
  startScreen: 'chat' | 'model' | 'settings',
  standalone: boolean,
  args: Args,
  initialMode?: PermissionMode,
  project?: string,
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
  enterBracketedPaste()
  try {
    const app = render(
      createElement(Shell, {
        initial: loaded,
        cwd: args.cwd ? resolveToolPath(process.cwd(), args.cwd) : DEFAULT_WORKING_DIRECTORY,
        startScreen: screen,
        standalone,
        initialMode,
        project,
        resumeId: args.resume ?? args.session,
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
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const command = resolveCommand(args.command)

  if (command === null) {
    console.error(`Unknown command: ${args.command}\n`)
    printHelp()
    process.exitCode = 1
    return
  }

  // Resource commands and `run` own their own flags, help text, and validation.
  if (isResourceCommand(command)) {
    switch (command) {
      case 'web': {
        const { runWeb } = await import('./web.js')
        await runWeb(argv)
        return
      }
      case 'spotlight': {
        const { runSpotlight } = await import('./spotlight.js')
        await runSpotlight(argv)
        return
      }
      case 'skills': {
        const { runSkills } = await import('./skills.js')
        process.exitCode = await runSkills(argv)
        return
      }
      case 'history': {
        const { runHistory } = await import('./history.js')
        process.exitCode = await runHistory(argv)
        return
      }
      case 'log': {
        const { runLog } = await import('./log.js')
        process.exitCode = await runLog(argv)
        return
      }
      case 'routines': {
        const { runRoutines } = await import('./routines.js')
        process.exitCode = await runRoutines(argv)
        return
      }
      case 'projects': {
        const { runProjects } = await import('./projects.js')
        process.exitCode = await runProjects(argv)
        return
      }
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        process.exitCode = await runMcp(argv)
        return
      }
      case 'google': {
        const { runGoogle } = await import('./google.js')
        process.exitCode = await runGoogle(argv)
        return
      }
      case 'chatgpt': {
        const { runChatGpt } = await import('./chatgpt.js')
        process.exitCode = await runChatGpt(argv)
        return
      }
      case 'pair': {
        const { runPair } = await import('./pair.js')
        process.exitCode = await runPair(argv)
        return
      }
      case 'devices': {
        const { runDevices } = await import('./devices.js')
        process.exitCode = await runDevices(argv)
        return
      }
      case 'version': {
        const extra = argv.slice(1)
        if (extra.length === 1 && (extra[0] === '--help' || extra[0] === '-h' || extra[0] === 'help')) {
          console.log('Usage:\n  milo version   Print the installed version and git commit')
          return
        }
        if (extra.length > 0) {
          console.error(`Unknown option "${extra[0]}". Valid options: --help (-h).`)
          process.exitCode = 1
          return
        }
        console.log(installVersionLine())
        return
      }
      case 'update': {
        const { runUpdate } = await import('./update.js')
        process.exitCode = await runUpdate(argv)
        return
      }
      case 'export': {
        const { runExport } = await import('./export.js')
        process.exitCode = await runExport(argv)
        return
      }
      case 'import': {
        const { runImport } = await import('./import.js')
        process.exitCode = await runImport(argv)
        return
      }
    }
  }

  if (command === 'run') {
    const { runCommand } = await import('./run.js')
    process.exitCode = await runCommand(argv)
    return
  }

  if (args.version) {
    console.log(installVersionLine())
    return
  }
  if (args.help) {
    if (command === 'serve') console.log(SERVE_USAGE)
    else printHelp()
    return
  }

  const problem = validateArgs(args)
  if (problem) {
    console.error(problem)
    process.exitCode = 1
    return
  }
  const initialMode = resolveInitialMode(args)

  // `milo run` resolves its own project after loading the config; the terminal
  // surfaces need only the id, and a bad reference is said here rather than after
  // the TUI has taken the screen.
  let project: string | undefined
  if (args.project) {
    const found = resolveProjectRef(args.project)
    if (!found) {
      console.error(`No project "${args.project}" is registered. See \`milo projects list\`.`)
      process.exitCode = 1
      return
    }
    project = found.id
  }
  if (args.cwd) {
    const folder = resolveToolPath(process.cwd(), args.cwd)
    if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`--cwd "${args.cwd}" is not a folder.`)
      process.exitCode = 1
      return
    }
  }

  switch (command) {
    case 'serve': {
      const { runServe } = await import('../gateways/serve.js')
      await runServe({ noWeb: args.noWeb, webPort: args.webPort })
      return
    }
    case 'model':
      await runTui('model', true, args, initialMode)
      return
    case 'setup':
      await runTui('settings', true, args, initialMode)
      return
    case 'chat':
      await runTui('chat', false, args, initialMode, project)
      return
  }
}

main().catch((error) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
