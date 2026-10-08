# Skills

A skill is a **procedure** the model can pick up on demand: a `SKILL.md` that says how to do something.
They live in one directory:

```
~/.milo/skills/<name>/SKILL.md
```

The file opens with a small frontmatter block and then the instructions:

```markdown
---
name: deploy
description: How to cut and ship a release in this repo
---

1. Run `npm run build`.
2. …
```

`name` is optional — the directory name is used when it is absent — but `description` is not: it is what
the model sees, so a skill without one is skipped.

Only the **index** — each skill's name and its one-line description — rides along with every request;
the instructions are loaded by the `read_skill` tool **only when a task matches**, and that tool is not
registered at all when no skill is installed. Skills are read once at startup, so adding one means
restarting `milo`; editing the body of one that exists does not, since the tool re-reads it per call.
`/skills` lists what was found.

`~/.milo/skills/` is created at startup and when `milo setup` opens its **Skills** section. The
directory is Milo's own; it does not read `~/.commandcode/skills`, though a symlink across is all it
takes to share them.

## Installing skills

`milo skills` is what fills that directory:

```bash
milo skills                 # what is installed
milo skills available       # the skills that ship with Milo
milo skills find [query]    # the most-installed in the directory
milo skills add <source>    # a local path, an http(s) URL, or owner/repo
milo skills remove <name>   # delete one
```

A `<source>` is a local directory holding a `SKILL.md`, a direct URL to one, `owner/repo` on GitHub, or
a **`skills.sh` page** (whose address encodes the same `owner/repo`, so a copied link installs). A
repository holding several skills makes you pick with `--skill <name>`. The same `SKILL.md` format is
what every other agent reads, so a skill from `npx skills` works here unchanged. `milo skills find`
reads the directory's ranking live, with each row's install count.

`milo setup` → **Skills** shows the same top five next to the bundled pair, each row with the repository
and install count plus the one-line summary. `Space` **picks** rows (several at once) and `Enter`
installs what was picked. If the page cannot be read the section says so and offers only what shipped
with Milo.

A few skills ship bundled (`milo skills available`) and are not written anywhere until you install one:
there is no enable flag, because *not installed* is what off looks like everywhere else in Milo.

A skill is instructions, not data, and cannot be fenced — being obeyed is the entire point of it — so
installing one from the open registry is closer to installing code than saving a note. The command shows
the name, description, source and size and asks before writing, nothing installs on its own, and **the
model has no tool that installs anything**.
