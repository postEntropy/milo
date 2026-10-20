# Work

Work is Milo's code workspace: a tab of its own in the web app and on the phone, where a
project's folder is the subject. It is a **place**, not a second system — the sessions are
the ordinary ones, with the folder they run in changed.

## The shape

- A **project** is a folder on the machine Milo runs on, registered in `~/.milo/projects.json`:
  an id, a name and a path, nothing else.
- A **work session** is an ordinary session whose working directory is the project's folder.
  Tools, the subagent, the prompt and permission decisions all read from there.
- The tab has two levels: the projects, and one project's own page.
- The index draws each project as a disclosure. Expanded by default, it holds the project's
  newest sessions — three of them, with any running or unread session always among them — and
  **All N sessions** opens the page for the rest. The chevron at the card's edge folds them;
  the card itself opens the page, and the sessions sit in the card's own body rather than in
  rows of their own, opening and folding with a short animation. What was folded stays
  folded on that client, web and phone alike. A project with no sessions has nothing to
  fold: it stays shut and carries no chevron, and its count says zero.

## The project's page

- **Sessions** that ran there, newest first, with the running mark.
- **New session here** — the composer starts an ordinary session in that folder. The first
  words may also be the ones that ask the agent to write the folder's rules.
- **Build or Plan** — the composer's mode switch. Build works in the folder. Plan keeps
  the tools that read and proposes a change; the write tools are out of the catalog and
  the permission gate refuses them anyway. **Approve plan** leaves Plan and starts the
  build turn with the plan as the turn before it.
- **Rules** — whether the folder carries an `AGENTS.md` (`present`, `absent`, or `unreadable`
  with the reason). The file's text is not shown here; it is read in Files. A folder with no
  rules offers one control that starts a session told to write them.
- **Changes** — the working tree read through git: files, hunks, additions and deletions.
  A folder that is not a repository, or one with no commit yet, says so and offers the one
  action that records a first state. Untracked, binary and permission-only files say why
  there is no hunk to draw.
- **Files** — the tree of the folder, read-only. A file rises in the same drawer a changed
  file's hunks do, and opens one page at a time, cut where the agent's own reader cuts it.

## What Work is not

- No editor. The person edits in their own editor; the agent edits through its tools. The
  tab reads.
- No second store. Projects and sessions are the install's, and the same session list feeds
  every surface.
- No per-project model, instructions or permission configuration beyond `AGENTS.md` — or
  `CLAUDE.md` when the folder carries that name instead.
- A surface of the web app and the phone. Telegram and Discord are not Work and will not
  be: their session list names a session's project and that is the whole of it. The CLI
  manages projects with `milo projects`, and works in one with `milo --project <ref>` or
  `milo run --project <ref>` — the same session and the same folder, without the tab.

## Behaviour

- One implementation per behaviour: `src/core/work.ts` (tree and file pages),
  `src/core/work-diff.ts` (git changes and the first state) and
  `src/core/agent/instructions.ts` (the folder's rules). The screens draw the shape those
  return; they do not parse git or the folder themselves. A session is drawn by one row per
  client — `web/src/sessions/SessionRow.tsx`, and the phone's `SessionRow` with the actions
  from `Support/SessionControls.swift` — so the drawer, the index and a project's page cannot
  disagree about a session's name, its second line or what it answers to.
- Git is the source of truth for changes. A folder that is not a repository is answered as
  that — never as an empty change list that would read as "nothing changed".
- Every path read is confined to the project's folder, and every refusal names what was
  wrong.
- The model may delegate a broad read to a subagent on its own initiative here; outside a
  project, delegation waits to be asked. The subagent works in the same folder and carries
  the same rules.
- The page re-reads while a turn writes (`work-changed`, held to one frame per second) and
  again when a turn ends (`sessions-changed`).
- A folder that is gone is named as gone; a session started there would not work.
- A session carries one mark at its row's edge, never two: it **breathes** while a turn
  runs there and stands **still** when the session moved after the person last looked at it.
  Running outranks unread. The project's card wears the same mark when any of its sessions
  is running or unread, because its rows may be folded shut.
- The unread mark is counted from a watermark the install keeps in
  `~/.milo/session-seen.json`, one moment per session — not from the transcript, which
  cannot say when the person read it. Opening or resuming a session is a look, and so is
  the start of a turn. The **end** of a turn is a look only where the answer is handed
  over whole: a terminal, a chat with a push behind it. The browser and the phone decide
  for themselves, writing the look when the answer lands while the thread is still the
  screen showing — leaving the chat before the reply arrives is what leaves it unread.
  A delivery with nobody looking (a routine's answer into a web chat no tab has open)
  does the same.
- Language, controls and vocabulary follow `AGENTS.md`.

## Deliberately later

- Rules per subfolder. `AGENTS.md` (or `CLAUDE.md`) is read at the project's root; a rule
  that follows a monorepo's packages needs the path the turn is touching first.
- MCP per project — an external tool server stays the install's.
- An editor in the tab.

## Code map

| Concern | Where |
| --- | --- |
| Projects on disk | `src/core/projects.ts`, `~/.milo/projects.json` |
| Folder tree and file pages | `src/core/work.ts` |
| Changes and first state | `src/core/work-diff.ts` |
| Project rules | `src/core/agent/instructions.ts` |
| Plan / Build | `src/core/agent/system.ts` (`PLAN_SECTION`), `src/core/tools/permission.ts` (`withPlan`, `isPlanTool`) |
| Daemon actions | `src/gateways/web/settings.ts` (`projects`, `project-*`) |
| Web tab | `web/src/work/Work.tsx`, `web/src/App.tsx` (`/work`) |
| A session row | `web/src/sessions/SessionRow.tsx`, `ios/Sources/Milo/Screens/WorkView.swift` |
| Phone tab | `ios/Sources/Milo/Screens/WorkView.swift` |
| CLI | `src/bin/projects.ts` |
| A session's project | `src/core/runtime.ts` (`adopt`), `src/core/sessions/` |
| A session's unread mark | `src/core/sessions/seen.ts`, `~/.milo/session-seen.json` |
