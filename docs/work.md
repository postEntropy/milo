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

## The project's page

- **Sessions** that ran there, newest first, with the running mark.
- **New session here** — the composer starts an ordinary session in that folder. The first
  words may also be the ones that ask the agent to write the folder's rules.
- **Rules** — whether the folder carries an `AGENTS.md` (`present`, `absent`, or `unreadable`
  with the reason). The file's text is not shown here; it is read in Files. A folder with no
  rules offers one control that starts a session told to write them.
- **Changes** — the working tree read through git: files, hunks, additions and deletions.
  A folder that is not a repository, or one with no commit yet, says so and offers the one
  action that records a first state. Untracked, binary and permission-only files say why
  there is no hunk to draw.
- **Files** — the tree of the folder, read-only. A file opens one page at a time, cut where
  the agent's own reader cuts it.

## What Work is not

- No editor. The person edits in their own editor; the agent edits through its tools. The
  tab reads.
- No second store. Projects and sessions are the install's, and the same session list feeds
  every surface.
- No per-project model, instructions or permission configuration beyond `AGENTS.md`.
- A surface of the web app and the phone only. Telegram and Discord are not Work and will
  not be: their session list names a session's project and that is the whole of it. The
  CLI manages projects with `milo projects`.

## Behaviour

- One implementation per behaviour: `src/core/work.ts` (tree and file pages),
  `src/core/work-diff.ts` (git changes and the first state) and
  `src/core/agent/instructions.ts` (the folder's rules). The screens draw the shape those
  return; they do not parse git or the folder themselves.
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
- Language, controls and vocabulary follow `AGENTS.md`.

## Deliberately later

- Starting a session already in a project from the terminal (`milo`, `milo chat`). The tab
  is the only place that does it today.
- MCP per project — an external tool server stays the install's.
- A global `~/.milo/AGENTS.md`, a `CLAUDE.md` fallback, and per-subfolder rules.
- An editor in the tab.
- The web redesign that follows the phone's white/black tone.

## Code map

| Concern | Where |
| --- | --- |
| Projects on disk | `src/core/projects.ts`, `~/.milo/projects.json` |
| Folder tree and file pages | `src/core/work.ts` |
| Changes and first state | `src/core/work-diff.ts` |
| Project rules | `src/core/agent/instructions.ts` |
| Daemon actions | `src/gateways/web/settings.ts` (`projects`, `project-*`) |
| Web tab | `web/src/work/Work.tsx`, `web/src/App.tsx` (`/work`) |
| Phone tab | `ios/Sources/Milo/Screens/WorkView.swift` |
| CLI | `src/bin/projects.ts` |
| A session's project | `src/core/runtime.ts` (`adopt`), `src/core/sessions/` |
