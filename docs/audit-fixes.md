# Audit Fixes Summary (Non-Bot Scope)

This document summarizes the fixes implemented from the full-project audit across the core runtime, CLI, gateways, Spotlight popup, Web UI, and iOS app.

**Out of scope for this pass:** all **Bots / Crew / Delegated Work (`BOT-*`)** items remain intentionally untouched for a dedicated pass.

---

## 1. Critical Blockers, Security & Build

- **Broken Web build (`B-01`):** Removed the dead `LogoLab` import and `web/src/ui/milo.ts` reference from `web/src/main.tsx` (product decision: deleted permanently).
- **Web panel token isolation (`W-01`):** Replaced raw bearer tokens (`?t=`) in framed panel URLs with short-lived artifact-scoped tickets (`issuePanelTicket` / `?p=`) in `web/src/lib/api.ts`, `web/src/panel/Panel.tsx`, and `src/gateways/web/http.ts`. Top-level window URLs keep `?t=` intentionally so iOS home-screen PWAs retain their pairing token across isolated Safari storage.
- **WebSocket & HTTP stream error handling (`G-02`):** Added error handlers on WebSocket connections and read streams in `src/gateways/web/http.ts` so dropped clients or unreadable files do not crash `milo serve` / `milo web`.
- **Auth lookup caching (`G-04`):** Cached paired-device lookups in `src/gateways/web/devices.ts` / `http.ts` instead of re-reading and hashing `devices.json` on every WebSocket message and streamed chunk.
- **CLI option dispatch & `milo serve` flags (`G-01`, `B-02`, `B-04`):** Updated `src/bin/args.ts`, `src/bin/dispatch.ts`, `src/bin/cli.ts`, `src/bin/run.ts`, and `src/bin/serve.ts` so subcommand flags are validated per command and `--help` / `--version` exit cleanly without starting the server.
- **CI & env hygiene (`B-06`, `B-09`, `B-10`):** Updated `.github/workflows/ci.yml`, `.gitignore`, `.env.example` (documented `GROQ_API_KEY`, `CMD_API_KEY`, `MILO_DEBUG`, `MILO_BROWSER_CHROME`), `web/tsconfig.json` (removed invalid `vite-env.d.ts` include path), and `src/bin/cli.ts` (`milo google` help copy). Converted `scripts/check-browser.ts` output to English per `AGENTS.md`, and stabilized timing-sensitive CLI UI tests in `test/chat-ui.test.tsx` and `test/shell-layout.test.tsx` (`B-03`).

---

## 2. Core Runtime, Memory, MCP, Sessions & Tools (`C-01`–`C-16`)

- **Agent loop, subagents & permissions:** Hardened tool execution, grant filtering, and subagent/permission paths in `src/core/agent/loop.ts`, `src/core/agent/subagent.ts`, `src/core/tools/permission.ts`, `src/core/tools/index.ts`, `src/core/tools/jobs.ts`, `src/core/tools/routine.ts`, `src/core/tools/rule-file.ts`, `src/core/tools/rules.ts`, `src/core/tools/sessions.ts`, and `src/core/tools/read-attachment.ts`.
- **Shell & git safety:** Tightened workspace/sandbox confinement and argument parsing in `src/core/tools/shell.ts`, `src/core/tools/shell-parse.ts`, `src/core/tools/git.ts`, `src/core/tools/format.ts`, and `src/core/work-diff.ts`.
- **Session retention & seen marks:** Fixed retention pruning order so protected/interactive sessions are not evicted ahead of routine runs, and updated `FileSessionSeen` atomic writes (`randomUUID()` temp names + cleanup on error) in `src/core/sessions/file-store.ts`, `src/core/sessions/memory-store.ts`, `src/core/sessions/compact.ts`, `src/core/sessions/seen.ts`, and `src/core/session.ts`.
- **Memory & local embeddings:** Fixed infinite zero-vector re-embedding / shutdown handling and Ollama download/stderr handling in `src/core/memory/sqlite.ts`, `src/core/memory/ollama.ts`, and `src/core/memory/derive.ts`.
- **MCP lifecycle:** Tightened server reload/shutdown handling and process cleanup in `src/core/mcp/servers.ts` and `src/core/mcp/client.ts`.
- **Skills, media, config, Google & browser:**
  - Updated `directoryStamp` in `src/core/skills/index.ts` to stat `SKILL.md` mtimes directly and removed the stale restart hint from `formatSkillList`.
  - Fixed atomic image writes, media parsing/cleanup, and config/runtime error handling in `src/core/images.ts`, `src/core/media.ts`, `src/core/config/load.ts`, `src/core/projects.ts`, `src/core/routines.ts`, `src/core/runtime.ts`, `src/core/task-lists.ts`, `src/core/google/{access,connect,oauth}.ts`, `src/core/browser/{metadata,session,tools}.ts`, and `src/util/fs.ts`.

---

## 3. Gateways, CLI & Spotlight (`G-05`–`G-14`)

- **Shared commands & turn locks (`G-07`):** Guarded `/clear`, normalized command casing, aligned Telegram/Discord `sessions` action routing with session locks, enforced decision ownership on Telegram permission buttons, normalized Telegram `@botname` command suffixes and `trim()`, registered the full `COMMAND_CATALOG`, and made Discord `answer` replies ephemeral in `src/gateways/commands.ts`, `src/gateways/telegram/index.ts`, and `src/gateways/discord/index.ts`.
- **Telegram HTML & rate limits (`G-08`):** Processed inline code/links before emphasis and sanitized language classes in `src/gateways/telegram/html.ts`, kept chunks within HTML limits in `src/gateways/telegram/reply.ts`, and isolated HTML fallback / `isNotModified` / `retry_after` handling in `src/gateways/telegram/messenger.ts`.
- **Discord & TurnQueue (`G-09`):** Enabled DM intents/partials and `Events.Error` logging, chunked long command/error replies, caught failed prompt replies, and stopped active `TurnQueue`s on gateway shutdown in `src/gateways/discord/index.ts`, `src/gateways/telegram/index.ts`, and `src/gateways/turns.ts`.
- **WebHub & settings (`G-06`, `G-11`):** Scoped `resolvePanel` to the session directory, broadcast panel and command results to all sockets viewing the session, routed `approve-plan` / `retry-command-code` to `liveOwner`, handled `/stop` turn control and slash-command `turn-start`/`turn-end` lifecycles in `src/gateways/web/hub.ts`, avoided shallow provider overwrites and active-session deletes in `src/gateways/web/settings.ts`, validated routine `allow` grants in `src/gateways/web/settings/routines.ts`, included `audio` attachments in `src/gateways/web/transcript.ts`, and bounded maps/buffers in `src/gateways/web/{http,pair,hub}.ts` and `src/gateways/turns.ts`.
- **CLI & Spotlight (`G-05`, `G-10`, `G-12`, `G-13`, `G-14`):**
  - Replaced the 1-slot width cache in `src/gateways/cli/transcript.ts` with a 2-width cache and fixed visual-width `wrapText`.
  - Isolated `useElapsed` timer updates, reused `incomingMime` and Command Code attachment handling, passed abort signals to compaction, refreshed folder state, added `groq` key slot, and prevented lost provider metadata in `src/gateways/cli/screens/{chat,model-picker,settings}.tsx`.
  - Consolidated shared TTY helpers (`src/util/terminal.ts`) and trim flag parsing (`src/bin/trim.ts`) across `src/bin/{chatgpt,devices,google,history,log,mcp,projects,routines,skills,web}.ts`.
  - Updated `spotlight/omarchy/Spotlight.qml` (keyboard focus independent of hover; `TapHandler` scoped off selectable text) and `src/bin/spotlight.ts` (`event.text` and `drawFailure`).

---

## 4. Web Frontend (`web/`, `W-02`–`W-11`)

- **Work / Session Folder & Command Code recovery (`W-02`):** Reconnected the topbar Folder control, `SessionFolder` modal, `SessionBackendMark`, `FolderInspector` (`/work`), `session-folder` / `session-backend` frames, `newChat({ project, backend })`, and Command Code recovery banner in `web/src/App.tsx`.
- **Email reliability & confirmations (`W-03`):** Added stale-request sequence guards, explicit retry states, double-submit lock, and in-app send/discard `alertdialog` confirmations (removing `window.confirm`) in `web/src/email/Email.tsx`.
- **Theme, controls & accessibility (`W-04`, `W-05`, `W-09`, `W-11`):**
  - Fixed `--warning` / `--danger` contrast, `.switch` off-track contrast, `.attachment-file` / `.genui-choice-card.on` filled surfaces, `.topbar-backend-popover p` sizing, `.welcome-description` wrapping, mobile `.crew-page` spacing, and CSS specificity lint warnings in `web/src/styles.css`.
  - Replaced native `<select>` elements in `web/src/analytics/Analytics.tsx` and `web/src/chat/genui/GenUi.tsx` with `<Select>`, validated `http:`/`https:` on button URLs in `web/src/chat/MessageList.tsx`, fixed nested `<Select>` Escape handling in `web/src/ui/Select.tsx`, updated `<PageHeader>` to render `<h1>` in `web/src/ui/PageHeader.tsx`, and eliminated nested `<main>` landmarks across `web/src/ui/Workspace.tsx`, `Analytics.tsx`, `Email.tsx`, `Settings.tsx`, and `web/src/work/FolderInspector.tsx`.
  - Added an explicit empty-state message when no keyed provider exists in `web/src/ui/ModelPicker.tsx`, fixed narrow-screen provider browsing in `web/src/chat/Composer.tsx`, and fixed unsaved/removable model hints in `web/src/settings/{Settings,MobileModelPicker}.tsx`.
- **Efficiency & resilience (`W-06`, `W-07`, `W-10`):** Added `React.lazy` + `Suspense` for secondary views in `web/src/App.tsx`, gated unread email polling on mail connection state, bounded `Composer.fileDrafts` (`8`), optimized `web/src/chat/Markdown.tsx`, guarded division by zero in `web/src/chat/genui/Chart.tsx`, throttled `MessageMenu` scroll placement, fixed MJPEG frame URL revocation in `web/src/panel/Panel.tsx`, kept error notices persistent until dismissed (`web/src/ui/Notice.tsx`), surfaced feed errors in `web/src/routines/Routines.tsx`, confirmed sidebar session deletion, added `online`/`visibilitychange` reconnect triggers + jitter in `web/src/lib/ws.ts`, and improved sidebar/row accessibility (`inert`, `aria-current`, `aria-label`) in `web/src/sessions/SessionRow.tsx`.

---

## 5. Native iOS App (`ios/`, `I-01`–`I-07` non-bot)

- **WebSocket lifecycle & frame ceiling (`I-01`, `I-03`):** Updated `MiloClient` (`ios/Sources/Milo/Transport/MiloClient.swift`) to cancel active reconnects and sockets in `connect(to:)`, store and cancel `sendConfirmed` timeout tasks in `pendingTimers`, validate `task === self.socket` on `hello` failures, add retry jitter, and enforce the `65_536`-byte frame limit before sending.
- **Session Folder access (`I-02`):** Added the Folder button in `ChatView` (`ios/Sources/Milo/Screens/ChatView.swift`) wired to `SessionFolderSheet` (`ios/Sources/Milo/Screens/SessionFolderSheet.swift`), exposing `Files`, `Changes`, and `Rules` inspection alongside folder selection and clearing.
- **State, lifecycle, performance & UI (`I-04`–`I-07`):**
  - Fixed dead `catch is URLError` handlers (`ApiError.unreachable`), preserved unrelated `note` banners during `refreshSessions`, separated nil-account error wording in `setSessionFolder`, and returned a send-success boolean from `send(_:target:)` in `ios/Sources/Milo/AppModel.swift`.
  - Added a confirmation dialog before removing API keys in `ios/Sources/Milo/Screens/SettingsView.swift`.
  - Surfaced routine feed errors and preserved `ask` text on failed sends in `ios/Sources/Milo/Screens/RoutinesView.swift`.
  - Stopped and cleared `StatusBarBlur.BlurView`'s `UIViewPropertyAnimator` when detached (`ChatView.swift`), moved `AVCaptureSession` configuration off `@MainActor` with `viewWillAppear` restoration (`ios/Sources/Milo/Screens/QRScanner.swift`), and replaced raw `.cornerRadius(2)` with `MiloTheme.Radius.xs` (`ios/Sources/Milo/Support/GenUiChart.swift`).
  - Cached locale-keyed `NumberFormatter` instances and compiled regexes in `ios/GenUi/Sources/MiloGenUi/Evaluate.swift` and removed per-step `Array(text)` and quadratic plain-text string concatenation in `ios/Highlight/Sources/MiloHighlight/Highlight.swift`.

---

## 6. Verification Run After Final Edits

- `npm run typecheck` (`tsc --noEmit`): passed.
- `npm run lint` (`biome lint .`, 562 files): passed with 0 errors and 0 warnings.
- `npm test` (`vitest run`): **190/190** test files passed (**2839/2839** tests).
- `npm --prefix web run typecheck` (`tsc -b --pretty false`) and `npm --prefix web run build` (`tsc -b && vite build`): passed (`web/dist/` built cleanly).
- Live Web UI browser verification on an isolated server (`1280x800` desktop and `390x844` mobile): zero console or page errors, zero horizontal overflow, verified Chat, ModelPicker empty provider message, Folder dialog, Routines, Tasks, Analytics, Email, Settings, and single `<main>` landmark.
- `cd ios && xtool dev build`: passed (`Milo.app` built cleanly).
- Linux SwiftPM suites (`swift test`): `ios/Connection` (**10/10**), `ios/GenUi` (**7/7**), and `ios/Highlight` (**3/3**) passed.

---

## Remaining / Intentionally Deferred

1. **Bots / Crew / Delegated Work (`BOT-*`):** All core, gateway, Web, and iOS findings in the dedicated Bot audit remain pending for the next pass.
2. **iOS Email screen (`I-03`) & device verification:** Email management on iPhone is not yet implemented, and visual inspection of `ios/` on physical hardware requires running `xtool dev run` against the paired device.
3. **Larger structural refactors (`W-08`, `C-14`, `I-08`):** Splitting large component/module files (e.g. `App.tsx`, `Settings.tsx`, `session.ts`) and adding a `Milo` test target in `ios/Package.swift` were kept out of this targeted fix pass.
