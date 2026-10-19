# The agent

The prompt a turn runs under is a base persona plus sections, assembled per turn by
`buildSystemPrompt`. `config.systemPrompt` replaces the persona only: the sections still
apply, because they carry live state and behaviour the persona cannot know.

## What a turn is told

- **The model's family** — every turn, on every surface. A gateway (`commandcode`,
  `opencode`) hides which family answered, so the family is read from the model id first,
  and from the provider only when the id says nothing. An unknown family gets no section,
  never a guess. The briefing is about the family's vices: comment density for Claude,
  mid-work steering and not reverting someone else's change for GPT.
- **The code manual** — only when the session works in a project's folder. It says to read
  before writing, match the folder, avoid inventing commands and files, keep the change
  small, and check the work with the project's own tests, typecheck or lint. A session
  without a project is not doing code, and carrying the manual into every chat would only
  spend tokens.
- **The folder's rules** — the project's `AGENTS.md`, read per turn by
  `src/core/agent/instructions.ts`. They are instructions to follow, and they land after
  the code manual, so the folder has the more specific word on how its code is worked in.
- **Live state** — the surface, the environment, the tool catalog, the setup, the skills,
  the remembered notes and the compaction summary. The environment names the session's
  project; the code manual is what turns that fact into how to work.

The subagent gets the same family section and the same project, because it runs under the
same model and in the same folder. A routine gets the family section too: it is a turn
like any other.

## The hierarchy

The person and the base policy outrank the folder's rules; the folder's rules outrank
habits. A folder can shape how the work is done, not whether it is allowed. The code
manual is part of the base policy, and the folder's `AGENTS.md` is the more specific word
inside it.

## Where it lives

| Concern | Where |
| --- | --- |
| Base persona | `src/core/agent/system.ts` (`DEFAULT_SYSTEM_PROMPT`) |
| Family briefings | `src/core/agent/system.ts` (`FAMILY_SECTIONS`) |
| Reading the family | `src/core/agent/model-family.ts` |
| Code manual | `src/core/agent/system.ts` (`PROJECT_CODE_SECTION`) |
| Project rules | `src/core/agent/instructions.ts` |
| Assembly order | `src/core/agent/system.ts` (`buildSystemPrompt`) |
| A session's project | `src/core/runtime.ts` (`adopt`), `src/core/sessions/` |

## Deliberately not here

These are separate decisions. A reference in a plan is not a feature.

- A model catalog: context window, compaction threshold, reasoning effort.
- An immutable snapshot per step (`StepContext`); the loop already records before it acts.
- Plan mode and default permission rules.
- A global `~/.milo/AGENTS.md`, a `CLAUDE.md` fallback, and per-subfolder rules.
- Headless `milo run`, OS-level sandbox, and the rest of the Codex surface.

## A family joins when a vice is observed

Two families, not one per model, and a briefing says only what the base prompt cannot say
for everyone. An unknown model runs on the base prompt. A family enters
`ModelFamily` when someone observes the vice in practice — never by imagination.
