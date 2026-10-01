/**
 * The console steps, written once.
 *
 * Three surfaces show these — `milo google connect`, the setup screen and the web
 * Settings — and they must not drift: a step that is right in one and stale in
 * another sends someone to the wrong page, which reads as a broken feature.
 *
 * Every URL here came out of Google's own documentation (`workspace/guides/enable-apis`
 * and the OAuth guides). A link printed for someone to click is a promise that it
 * opens something, so nothing here is guessed — which is also why the consent
 * screen is named rather than deep-linked: its console page moves.
 */
export interface GoogleStep {
  /** What the person does, in the imperative. */
  what: string
  /** Why, when it is not obvious. */
  why?: string
  url?: string
}

export const GOOGLE_CONSOLE = 'https://console.cloud.google.com'

/**
 * The shortcut Google documents for exactly this: it creates the project, turns
 * on every Workspace API at once and hands back a `credentials.json` carrying the
 * client id and secret — the file `milo google connect --credentials` reads.
 */
export const GOOGLE_SHORTCUT = 'https://developers.google.com/workspace/guides/enable-apis'

export const GOOGLE_STEPS: GoogleStep[] = [
  {
    what: 'Create a Cloud project, or pick one you already have',
    why: 'One project serves everything Milo may ever use from Google.',
    url: 'https://developers.google.com/workspace/guides/create-project',
  },
  {
    what: 'Enable the Gmail API',
    url: `${GOOGLE_CONSOLE}/apis/enableflow;apiid=gmail.googleapis.com`,
  },
  {
    what: 'Enable the Drive API',
    url: `${GOOGLE_CONSOLE}/apis/enableflow;apiid=drive.googleapis.com`,
  },
  {
    what: 'OAuth consent screen: External, an app name, and your own address as a test user',
    why: 'Without it Google refuses the authorization before it even asks. While the app stays in "Testing" the access expires every seven days, so publish it afterwards.',
    url: `${GOOGLE_CONSOLE}/apis/credentials`,
  },
  {
    what: 'Create credentials → OAuth client ID → application type "Desktop app"',
    why: 'The type matters: it is what lets the redirect come back to 127.0.0.1 on this machine.',
    url: `${GOOGLE_CONSOLE}/apis/credentials`,
  },
  {
    // Deliberately not "run the connect command": these steps are read from
    // inside that command, from the setup screen that replaces it, and from the
    // web page that can only point at it. What is true in all three is *where*
    // the work happens, so that is what the step says — the imperative belongs to
    // whoever is showing it.
    what: 'Work at the machine that runs Milo, where the browser comes back to',
    why: 'From a phone it cannot finish: Google refuses the Gmail scopes in its device flow, and the redirect arrives at the machine that started it.',
  },
]

/** The same steps as plain lines, for a terminal that is not a TUI. */
export function googleStepsInWords(): string[] {
  return GOOGLE_STEPS.flatMap((step, index) => [
    `${index + 1}. ${step.what}`,
    ...(step.why ? [`     ${step.why}`] : []),
    ...(step.url ? [`     ${step.url}`] : []),
  ])
}
