# The agent

A Milo-backed turn runs under a base persona plus sections, assembled per turn by
`buildSystemPrompt`. `config.systemPrompt` replaces the persona only: the sections still
apply, because they carry live state and behaviour the persona cannot know. A Session started
inside a Work project may instead select Command Code; it owns its model, tools and native JSONL history.
Milo stores a link to that history and projects it into the chat UI, but never writes a second
copy into `SessionRecord.messages`. Milo's prompt sections, memory, Plan mode and per-tool
permission policy do not apply to Command Code; the CLI reads its own project rules and runs
with `--yolo`. The active Session's Command Code mark opens the access details; starting a
Session does not show a warning.

## What a turn is told

- **The model's family** — every turn, on every surface. A gateway (`commandcode`,
  `opencode`) hides which family answered, so the family is read from the model id first,
  and from the provider only when the id says nothing. An unknown family gets no section,
  never a guess. The briefing is about the family's vices: comment density for Claude,
  mid-work steering and not reverting someone else's change for GPT.
- **Plan mode** — only while the session is proposing rather than working. The catalog
  carries what reads, what stays inside Milo, and what delegates; the permission policy
  refuses anything that would still change a file or run a command. The section asks for a
  concrete plan — files, steps, risks, how it will be checked — and says the work has not
  started. A surface turns it on and off; approving the plan ends it and starts the
  execution turn.
- **The code manual** — only when the session works in a project's folder. It says to read
  before writing, match the folder, avoid inventing commands and files, keep the change
  small, and check the work with the project's own tests, typecheck or lint. A session
  without a project is not doing code, and carrying the manual into every chat would only
  spend tokens.
- **The install's rules** — `~/.milo/AGENTS.md`, read per turn by the same reader. They
  sit above every project's and apply in every session. A standing instruction the person
  states for the future ("from now on, keep answers short") is written into that file by
  the `instructions` tool, under `## Preferences`, so it is carried from the next turn on
  instead of being recalled like a note. `scope: "project"` writes to the current project's
  `AGENTS.md`; without it, the install file is used. A fact stays with `remember`.
- **The folder's rules** — the project's `AGENTS.md`, or `CLAUDE.md` when that is the one
  it carries, read per turn by `src/core/agent/instructions.ts`. They are instructions to
  follow, and they land after the code manual, so the folder has the more specific word on
  how its code is worked in. A folder that has both is read from `AGENTS.md`; an
  `AGENTS.md` that exists but cannot be read does not silently fall through to `CLAUDE.md`.
- **Attachments** — their content is evidence rather than authority; the catalog offers
  `read_attachment` when this session has documents, so extracted text stays available after
  the initial preview and after compaction. The vision helper describes images for the
  answering model without carrying the attachment's instructions into the helper's system.
- **Live state** — the surface, the environment, the tool catalog, the setup, the skills,
  the remembered notes and the compaction summary. The environment names the session's
  project; the code manual is what turns that fact into how to work.
- **The verification gate** — not a prompt section: an event after the turn. When
  `verification.enabled` is on and the turn wrote anything in a project, the project's own
  test/typecheck/lint commands run. A failed check is sent back to the model for one bounded
  repair attempt, followed by one more check run. Results stay on the answers they verified
  and in trace lines. The gate stays opt-in because project commands execute code.
  Discovery is `src/core/verification.ts`: `projects.json` → `checks`, then `package.json`
  scripts, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Makefile`. Off by default.

The subagent gets the same family section, the same plan section when the parent is
planning, and the same project, because it runs under the same model and in the same
folder. A routine gets the family section too: it is a turn like any other.

In a project, the `task` tool lets the model delegate on its own: a broad search or a long
read is exactly what a subagent keeps out of the session. Outside a project, it waits
to be asked. The tool's description is the whole rule, and it is chosen per turn from
whether the session has a project.

The external Command Code agent started from the web Work page is separate from this
subagent. Herdr owns its terminal; Milo supplies the project folder and the install and
project rules, but cannot enforce its permission policy, Plan mode, or sandbox on that
process. Starting it does not prompt; the mark in an active Session's header opens the
access details for `--yolo`.

## The hierarchy

The person and the base policy outrank the install's rules, and the install's rules outrank
the folder's; the folder's outrank habits. A folder or `~/.milo` can shape how the work is
done, not whether it is allowed. The code manual is part of the base policy; the install's
`AGENTS.md` refines it everywhere, and the project's is the more specific word inside it.
An order in either is an instruction to follow, never a promotion over the person.

## Where it lives

| Concern | Where |
| --- | --- |
| Base persona | `src/core/agent/system.ts` (`DEFAULT_SYSTEM_PROMPT`) |
| Family briefings | `src/core/agent/system.ts` (`FAMILY_SECTIONS`) |
| Reading the family | `src/core/agent/model-family.ts` |
| Plan section | `src/core/agent/system.ts` (`PLAN_SECTION`) |
| Code manual | `src/core/agent/system.ts` (`PROJECT_CODE_SECTION`) |
| Project and install rules | `src/core/agent/instructions.ts` |
| Writing a rule into them | `src/core/tools/instructions.ts` (the `instructions` tool) |
| Model profile | `src/core/providers/profile.ts`, `~/.milo/models.json` |
| Verification gate | `src/core/verification.ts` |
| Assembly order | `src/core/agent/system.ts` (`buildSystemPrompt`) |
| A session's project | `src/core/runtime.ts` (`adopt`), `src/core/sessions/` |
| Command Code backend and native transcript projection | `src/core/command-code-session.ts`, `src/core/command-code-history.ts` |

## Deliberately not here

These are separate decisions. A reference in a plan is not a feature.

- An immutable snapshot per step (`StepContext`); the loop already records before it acts.
- Per-subfolder rules: `AGENTS.md` is read at the project's root, not per directory.
- LSP diagnostics; the verification gate has to run first.
- An OS sandbox beyond `sandbox: workspace` (path confinement plus `bwrap` on Linux).
- Repeating repair attempts beyond the single automatic follow-up.

## A family joins when a vice is observed

Two families, not one per model, and a briefing says only what the base prompt cannot say
for everyone. An unknown model runs on the base prompt. A family enters
`ModelFamily` when someone observes the vice in practice — never by imagination.
