# Development

```bash
npm run dev         # run the CLI from source (tsx)
npm run serve       # run the bot gateways and the web UI from source
npm run build:web   # build web/ into web/dist, which `milo serve` serves
npm run typecheck   # tsc --noEmit
npm run lint        # biome lint
npm test            # vitest
npm run build       # bundle to dist/ (tsup)
npm run bench:jev       # classifier latency (needs COMMANDCODE_API_KEY, or a local Ollaya)
npm run bench:browser   # what the browser toolset costs (needs a browser)
npm run bench:memory    # what recall costs
npm run eval:memory     # what recall gets right (add --semantic for the local engine)
npm run eval:mem0       # the same set through mem0, verbatim and with its pipeline
npm run check:browser   # that every verb in it works (needs a browser)
```

CI (`.github/workflows/ci.yml`) runs lint, types, tests with coverage and the build on every push and
pull request, plus a smoke run of the bundled binary. One trap worth knowing: with `NODE_ENV=production`
exported in your shell, npm treats every install as `--omit=dev` and **prunes the toolchain** — `tsc`,
`vitest` and `tsup` disappear. Recover with `npm ci --include=dev`.

## Source layout

- `src/core/` — the agent core, no UI or transport.
  - `providers/` — `Provider` interface + OpenAI/Anthropic adapters + wire factory.
  - `agent/` — the loop (`runAgent`), events, system prompt.
  - `tools/` — `Tool` interface, registry (zod → JSON Schema), built-in tools.
  - `search/` — `SearchProvider` plus the Tavily, Exa and Parallel adapters.
  - `memory/` — the `Memory` interface, the SQLite store (`sqlite.ts`), the coverage rule that trims a
    reply (`coverage.ts`), the JSON store it replaced (`local.ts`) and the one-time import
    (`migrate.ts`).
  - `skills/` — `SKILL.md` discovery, frontmatter parsing, and the loader behind the `read_skill` tool.
  - `mcp/` — the external tool servers: the hand-rolled JSON-RPC wire and its two eras, the stdio
    client, the listing cache the catalog is built from, and the manager that owns the processes.
  - `browser/` — the CDP client, finding and starting Chrome, copying a profile out of another browser,
    the page observer, and the three tools.
  - `google/` — the OAuth flow, the token source the tools read, and the Gmail and Drive clients.
  - `sessions/` — `SessionStore` interface + `FileSessionStore` / `MemorySessionStore`, the recaps kept
    out of a transcript (`RecapStore`) and their ranking (`rankSessions`), nickname generation,
    compaction (`estimateTokens` / `planCut` / `planCutUnderBudget` / `summarize`), retention
    (`pruneSessions`) and `/stats` formatting.
  - `config/` — paths, zod schema, presets, load/save, onboarding wizard.
  - `runtime.ts` / `session.ts` / `bootstrap.ts` / `history.ts` (the log and its readout) /
    `traces.ts` (the execution log).
- `src/gateways/` — `cli/` (Ink), `telegram/` (grammY), `discord/` (discord.js) and `web/` (the HTTP +
  WebSocket server, the hub that drives turns, the settings actions and the job registry).
- `web/` — the browser frontend (React + Vite), built into `web/dist` and served by `src/gateways/web/`.
- `src/bin/` — `cli.ts` (`milo`), `serve.ts` (`milo serve`), `web.ts` (`milo web`), and the plain
  terminal commands `skills.ts` (`milo skills`), `history.ts` (`milo history`), `log.ts` (`milo log`),
  `routines.ts` (`milo routines`) and `google.ts` (`milo google`).
