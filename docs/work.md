# Session folders

All Sessions share one list, whether or not they work in a folder. A folder is optional
Session context. Choosing a directory does not require a separate project setup screen.
The host remembers selected folders in the existing projects registry for reuse.

## Choosing a folder

The Session's Folder control offers direct host-folder browsing, a path, recent folders,
and Clear folder. `/folder <path>` performs the same operation from CLI, Telegram, Discord,
web or iPhone; `/folder` shows the current context and `/folder none` clears it.

Selection preserves the Session ID and transcript. It is refused while the Session is
busy or has a running background job. The change is recorded in the transcript and applies
to subsequent tools, commands, the code manual and folder instructions. Old permission
approvals are cleared. Another process adopts saved directory context before its next turn.
A missing or unreadable folder is reported explicitly, never silently replaced.

## Starting and inspecting

New session remains the primary action. Its recent-folder menu can create a Session in a
remembered directory, using Milo or an available Command Code backend. Existing Sessions
retain their backend, folder and history. No transcript migration is required.

The folder name in a Session opens Files, Changes and Rules. These inspect the host folder;
there is no editor. Git remains the source of truth for changes. An unavailable repository,
unreadable rules or truncated listing must be explained with an appropriate recovery path.
Rules are read from AGENTS.md, or CLAUDE.md when appropriate, by the shared instruction reader.

## Native backends

Command Code runs with its own tools, permissions and native history under Herdr. Its
folder is fixed for the native Session; choose New session in another folder to change it.
Milo's Plan mode and permission policy do not apply to Command Code. Removing its Milo
link does not remove native history. Existing external Sessions stay discoverable in the
same unified list.

## Shared implementation

- `src/core/projects.ts`: remembered host folders and validation.
- `src/core/runtime.ts`: automatic folder registration/reuse and Session selection.
- `src/core/session.ts`: leased context changes, notices, approval reset and cross-process adoption.
- `src/core/agent/instructions.ts`: install and folder rules.
- `src/core/work.ts`, `src/core/work-diff.ts`: shared inspection operations.
- `src/gateways/commands.ts`: shared `/folder` command.
- `src/gateways/web/settings.ts`: authenticated Session folder action.

Legacy project IDs remain internal references. The old Chat/Work split is superseded by
optional folders on ordinary Sessions. The CLI's project references remain compatible.
