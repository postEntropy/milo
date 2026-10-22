# Working in this repo

Milo is one core drawn by several surfaces: a terminal UI, the web app, the iPhone and the
chat gateways (Telegram, Discord). These are the rules the project is held to. They are the short
form of the author's own taste notes, which live outside the repo in
`.commandcode/taste/` — read those when a rule below needs its reasoning.

## Language

- The product's interface is **English**, everywhere: buttons, labels, empty states,
  notices, errors, help text. The person who builds it speaks Portuguese; the product
  does not. Portuguese in user-facing copy is a defect, accents or not.
- Portuguese is fine where it is *data* — the lexical memory's stopword list, for one.
- Code, comments, commit messages and docs are English.

## One implementation per behaviour

- Two surfaces draw the same thing from the **same function**, never from two
  implementations that drift. Shared formatting lives in `src/core`; the `/sessions`
  list is `buildSessionsList` in `src/gateways/actions.ts`.
- A capability belongs to the whole class it belongs to, not to the surface that asked
  for it: touching one gateway means touching the CLI, Telegram, Discord, web and the phone.
- Email carries no exception. Reading and writing are both core capabilities the web **Email**
  screen and the agent reach through the same functions: the agent's `gmail_modify` and
  `mail_labels` are gated on the grant and ask before acting, and they reach the bin — Gmail's
  `trash`, recoverable — never a permanent delete. A routine that acts on mail carries the grant
  in `allow`. Drive stays read-only.
- Same data, same meaning everywhere. Something that is not actionable is marked
  `disabled` in the model and drawn inert on every surface — never guessed at.

## Interface

- Controls are **filled, not outlined**: `border: 0` plus a surface token
  (`--surface`, `--surface-warm`), `--border-soft` on hover. Buttons, cards, pills, rows,
  the user's own bubble. Borders belong to fields, panels and content chrome (code
  blocks, tool lines), never to something you press.
- The accent colour is a pointer, not a paint: the cursor and the selected row, not
  every value on the screen.
- Do not repeat on screen what is already there, and explain an interaction **once** —
  in the footer, never on every row.
- No shortcut legends and no boilerplate disclaimers on the surface; a control carries
  that in its tooltip.
- Type sizes come from the existing scale; a section does not pick its own.

## Vocabulary

- The entity is a **Session**, never "conversation".
- A name must say what the thing does. A label that promises more than the behaviour is
  a defect, and so is a second name for something that already has one.

## Work

- Work is the code workspace: a tab of its own in the web app and on the phone, with
  projects, files, changes and rules. It is a place, not a second system — a work session is
  an ordinary session in the project's folder. What it is and is not is in
  [docs/work.md](docs/work.md); read that before changing the tab.

## Agent

- What a turn is told — the base persona, the model-family briefing, the project's code
  manual and the folder's rules — is in [docs/agent.md](docs/agent.md); read it before
  changing the prompt or what a surface carries into it.

## Code

- No dead code, no speculative abstraction. An export only its own test uses is deleted;
  an unreachable branch is deleted.
- Nothing fails in silence. A handler that swallows an error, or a displayed thing that
  vanishes, is wrong.
- Prefer a discriminated outcome — `{ ok: true; result } | { ok: false; error }` — over
  a "maybe result" the caller can quietly ignore.
- A command given an argument it does not recognise answers with the valid ones; it never
  falls back to a default without saying so.
- Types that cross a boundary are defined once.

## Tests

- `test/conventions.test.ts` encodes four of the rules above: English copy on the surfaces
  the person reads, no outlined controls, and the shared scales for corner rounding and type
  sizes. It fails on purpose when a new string, button or raw literal breaks one — fix the
  code, not the check.
- Test names are sentences about behaviour: `it('pages the list five at a time')`.
- Before calling anything done, the check follows what changed — and a screen is checked
  by looking at it, not by the compiler:
  | Changed | Check |
  | --- | --- |
  | `src/`, `test/` | `npm test`, `npm run typecheck`, `npm run lint` |
  | `web/` | `npm --prefix web run typecheck`, and the screen in the browser |
  | `ios/` | `xtool dev build`, and the screen on the device |
  | `docs/`, `AGENTS.md` | none, and no code check is claimed for it |

## iOS

- The iOS app is built and installed straight onto the device over the network with
  `xtool dev run`; there is no simulator and no Xcode project to open — xtool is the
  whole loop.

## Commits

- `area: what the change does`, lowercase and plain — for example
  `sessions: sweep an empty session even when a scope is bound to it`.
- One subject per commit. Unrelated changes never ride along in the same one.
- Do not commit or push on your own initiative: leave the finished work on disk and
  wait for an explicit go-ahead. A commit request is not a push request.
- No `Co-authored-by` trailer, ever.
