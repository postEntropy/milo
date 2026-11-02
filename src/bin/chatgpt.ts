import { spawn } from 'node:child_process'
import {
  beginChatGptBrowserLogin,
  beginChatGptDeviceLogin,
  chatGptPlanName,
  chatGptStatus,
  enableChatGptProvider,
  forgetChatGptAccount,
  importCodexLogin,
} from '../core/chatgpt/auth.js'
import { errorMessage } from '../util/errors.js'

const USAGE = `milo chatgpt — sign in with a ChatGPT (Codex) subscription

Usage:
  milo chatgpt login             Sign in in a browser
  milo chatgpt login --device    Sign in on another device, with a one-time code
  milo chatgpt status            Show who is signed in
  milo chatgpt logout            Forget the sign-in on this machine

Flags:
  --device   Use the one-time-code flow (for a headless or remote machine)
  --new      Start a fresh sign-in instead of importing a Codex login
`

/**
 * `milo chatgpt` — the sign-in the ChatGPT preset is gated on. The same grant
 * is also written to Codex's own file, so one sign-in serves both tools.
 */
export async function runChatGpt(argv: string[]): Promise<number> {
  // `cli.ts` hands over the whole command line, as it does to every resource
  // command; the bare word is this command's own name, not a subcommand.
  const args = argv[0] === 'chatgpt' ? argv.slice(1) : argv
  const [sub, ...rest] = args
  const device = rest.includes('--device')
  const fresh = rest.includes('--new')

  switch (sub ?? 'status') {
    case 'login':
      return login({ device, fresh })
    case 'status':
      return status()
    case 'logout':
      forgetChatGptAccount()
      console.log('Signed out of ChatGPT. Codex keeps its own login.')
      return 0
    default:
      console.error(USAGE)
      return 1
  }
}

async function login(options: { device: boolean; fresh: boolean }): Promise<number> {
  const current = chatGptStatus()
  if (current.signedIn && !options.fresh) {
    console.log(`Already signed in as ${who(current)}.`)
    console.log('Use `milo chatgpt login --new` to sign in with another account.')
    return 0
  }

  if (!options.fresh) {
    try {
      const imported = await importCodexLogin()
      if (imported) {
        enableChatGptProvider()
        console.log(`Imported the Codex login: ${who(imported)}.`)
        return 0
      }
    } catch (error) {
      console.log(`A Codex login was found but could not be used (${errorMessage(error)}); signing in again.`)
    }
  }

  try {
    if (options.device) {
      const pending = await beginChatGptDeviceLogin()
      console.log('Open this link and sign in to ChatGPT:')
      console.log(`  ${pending.verificationUrl}`)
      console.log('')
      console.log('Enter this one-time code:')
      console.log(`  ${pending.userCode}`)
      console.log('')
      console.log('Waiting for sign-in…')
      const account = await pending.wait
      enableChatGptProvider()
      console.log(`Signed in as ${who(account)}.`)
      return 0
    }

    const pending = await beginChatGptBrowserLogin()
    console.log('Open this link and sign in to ChatGPT:')
    console.log(`  ${pending.url}`)
    console.log('')
    openBrowser(pending.url)
    console.log('Waiting for sign-in…')
    const account = await pending.wait
    enableChatGptProvider()
    console.log(`Signed in as ${who(account)}.`)
    return 0
  } catch (error) {
    console.error(errorMessage(error))
    return 1
  }
}

function status(): number {
  const current = chatGptStatus()
  if (!current.signedIn) {
    console.log('Not signed in. Run `milo chatgpt login`.')
    if (current.codexLogin) console.log('A Codex login was found; `milo chatgpt login` imports it.')
    return 0
  }
  enableChatGptProvider()
  console.log(`Signed in as ${who(current)}.`)
  if (current.expiresAt) {
    console.log(`The access token is renewed automatically; the next one expires ${new Date(current.expiresAt).toLocaleString()}.`)
  }
  return 0
}

function who(account: { email?: string; planType?: string }): string {
  const email = account.email ?? 'this account'
  const plan = chatGptPlanName(account.planType)
  return plan ? `${email} (ChatGPT ${plan})` : email
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? (['open', [url]] as const)
      : process.platform === 'win32'
        ? (['cmd', ['/c', 'start', '', url]] as const)
        : (['xdg-open', [url]] as const)
  try {
    const child = spawn(command[0], [...command[1]], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is printed above; opening a browser is a convenience.
  }
}
