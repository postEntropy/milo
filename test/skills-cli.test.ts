import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Point the app at a throwaway home *before* the config modules load.
const home = mkdtempSync(path.join(tmpdir(), 'milo-skills-cli-'))
process.env.MILO_HOME = home

const { runSkills } = await import('../src/bin/skills.js')
const { parseLeaderboard, parseSummary } = await import('../src/core/skills/catalog.js')
const { createToolRegistry } = await import('../src/core/tools/index.js')

const skillFile = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`

const temps: string[] = []

/** A throwaway directory holding one `SKILL.md` to install from. */
function makeSource(markdown: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-skill-src-'))
  temps.push(dir)
  writeFileSync(path.join(dir, 'SKILL.md'), markdown)
  return dir
}

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'milo-skill-proj-'))
  temps.push(dir)
  return dir
}

interface Capture {
  out: string[]
  err: string[]
  io: {
    out(line: string): void
    err(line: string): void
    confirm(question: string): Promise<boolean>
    cwd: string
  }
  text(): string
  errorText(): string
}

/** `answers` are handed to each confirmation, in order. */
function capture(answers: boolean[] = [], cwd = home): Capture {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      confirm: async () => answers.shift() ?? false,
      cwd,
    },
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  }
}

const globalSkill = (name: string) => path.join(home, 'skills', name, 'SKILL.md')

beforeEach(() => {
  rmSync(path.join(home, 'skills'), { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('milo skills', () => {
  it('says nothing is installed, and where to look', async () => {
    const run = capture()

    expect(await runSkills(['skills', 'list'], run.io)).toBe(0)

    const text = run.text()
    expect(text).toContain('global —')
    expect(text).toContain('Nothing installed')
    expect(text).toContain('milo skills available')
  })

  it('installs from a local directory and records where it came from', async () => {
    const source = makeSource(skillFile('deploy', 'How to deploy'))
    const run = capture()

    expect(await runSkills(['skills', 'add', source, '--yes'], run.io)).toBe(0)

    expect(existsSync(globalSkill('deploy'))).toBe(true)
    expect(readFileSync(globalSkill('deploy'), 'utf8')).toContain('How to deploy')
    const sidecar = JSON.parse(
      readFileSync(path.join(home, 'skills', 'deploy', '.milo.json'), 'utf8'),
    )
    expect(sidecar.source).toBe(source)
    // It said where the file went, and that a restart is what picks it up.
    expect(run.text()).toContain(globalSkill('deploy'))
    expect(run.text()).toContain('Restart milo')
  })

  it('refuses a file with no description, and writes nothing', async () => {
    const source = makeSource('---\nname: nameless\n---\n\nbody\n')
    const run = capture()

    expect(await runSkills(['skills', 'add', source, '--yes'], run.io)).toBe(1)

    expect(run.errorText()).toContain('no description')
    expect(existsSync(path.join(home, 'skills', 'nameless'))).toBe(false)
  })

  it('installs a built-in by name without touching the network', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const run = capture()

    expect(await runSkills(['skills', 'add', 'skill-creator', '--yes'], run.io)).toBe(0)

    expect(fetcher).not.toHaveBeenCalled()
    expect(existsSync(globalSkill('skill-creator'))).toBe(true)
  })

  it('does not install without a yes', async () => {
    const source = makeSource(skillFile('deploy', 'How to deploy'))
    const run = capture([])

    expect(await runSkills(['skills', 'add', source], run.io)).toBe(0)

    expect(run.text()).toContain('Nothing installed.')
    expect(existsSync(globalSkill('deploy'))).toBe(false)
    // The bare-Enter case is a no: the prompt showed what it was asking about.
    expect(run.text()).toContain('How to deploy')
  })

  it('keeps a project install out of the global directory', async () => {
    const project = makeDir()
    const source = makeSource(skillFile('deploy', 'How to deploy'))
    const run = capture([], project)

    expect(await runSkills(['skills', 'add', source, '--project', '--yes'], run.io)).toBe(0)

    expect(existsSync(path.join(project, '.milo', 'skills', 'deploy', 'SKILL.md'))).toBe(true)
    expect(existsSync(globalSkill('deploy'))).toBe(false)
  })

  it('removes one, and refuses a name that is not there', async () => {
    const source = makeSource(skillFile('deploy', 'How to deploy'))
    const run = capture()
    await runSkills(['skills', 'add', source, '--yes'], run.io)

    expect(await runSkills(['skills', 'remove', 'deploy'], run.io)).toBe(0)
    expect(existsSync(path.join(home, 'skills', 'deploy'))).toBe(false)

    const missing = capture()
    expect(await runSkills(['skills', 'remove', 'nope'], missing.io)).toBe(1)
    expect(missing.errorText()).toContain('No skill "nope"')
  })

  it('reports the origin in the listing, and says when one was added by hand', async () => {
    const source = makeSource(skillFile('deploy', 'How to deploy'))
    const run = capture()
    await runSkills(['skills', 'add', source, '--yes'], run.io)

    // A skill that was dropped in by hand has no provenance on disk, and the
    // listing says so instead of inventing one.
    mkdirSync(path.join(home, 'skills', 'by-hand'), { recursive: true })
    writeFileSync(
      path.join(home, 'skills', 'by-hand', 'SKILL.md'),
      skillFile('by-hand', 'Written by hand'),
    )

    const listed = capture()
    expect(await runSkills(['skills', 'list'], listed.io)).toBe(0)
    expect(listed.text()).toContain(`from ${source}`)
    expect(listed.text()).toContain('added by hand')
  })

  it('lists what ships with Milo and what is only suggested', async () => {
    const run = capture()

    expect(await runSkills(['skills', 'available'], run.io)).toBe(0)

    const text = run.text()
    expect(text).toContain('Ships with Milo')
    expect(text).toContain('skill-creator')
    // Nothing suggested is vouched for, and the command says which command.
    expect(text).toContain('not reviewed by Milo')
    expect(text).toContain('milo skills add vercel-labs/agent-skills')
  })

  it('installs one skill from a URL', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(skillFile('remote', 'Fetched from a URL'), { status: 200 }),
    )
    const run = capture()

    const code = await runSkills(
      ['skills', 'add', 'https://example.com/skills/remote/SKILL.md', '--yes'],
      run.io,
    )

    expect(code).toBe(0)
    expect(existsSync(globalSkill('remote'))).toBe(true)
  })

  it('takes an owner/repo, and one skill from it', async () => {
    vi.stubGlobal('fetch', githubFetch(['alpha', 'beta']))
    const run = capture()

    // Two skills and no choice made: it lists them and installs neither.
    expect(await runSkills(['skills', 'add', 'acme/skills'], run.io)).toBe(0)
    expect(run.text()).toContain('holds 2 skills')
    expect(run.text()).toContain('alpha')
    expect(existsSync(globalSkill('alpha'))).toBe(false)

    const chosen = capture()
    const code = await runSkills(['skills', 'add', 'acme/skills', '--skill', 'alpha', '--yes'], chosen.io)
    expect(code).toBe(0)
    expect(existsSync(globalSkill('alpha'))).toBe(true)
    expect(existsSync(globalSkill('beta'))).toBe(false)
  })

  it('takes a skills.sh page as the repository it points at', async () => {
    const fetcher = vi.fn(githubFetch(['alpha']))
    vi.stubGlobal('fetch', fetcher)
    const run = capture()

    const code = await runSkills(
      ['skills', 'add', 'https://skills.sh/acme/skills', '--yes'],
      run.io,
    )

    expect(code).toBe(0)
    expect(existsSync(globalSkill('alpha'))).toBe(true)
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('api.github.com/repos/acme/skills')
  })

  it('gives the model no way to install anything', () => {
    // Installing is a human act: a tool that could install instructions is a
    // tool that could be talked into installing more of them.
    const names = createToolRegistry()
      .list()
      .map((tool) => tool.name)

    expect(names.filter((name) => name.includes('skill'))).toEqual([])
    expect(names).not.toContain('install')
  })

  it('names the round trip before it goes looking', async () => {
    vi.stubGlobal('fetch', githubFetch(['alpha']))
    const run = capture()

    await runSkills(['skills', 'add', 'acme/skills', '--yes'], run.io)

    // A wait the command never mentions is read as a hung command.
    expect(run.text()).toContain('Looking up acme/skills…')
  })

  it('lists the directory ranking with its install counts, filtered by a query', async () => {
    vi.stubGlobal('fetch', async () => new Response(LEADERBOARD, { status: 200 }))
    const all = capture()
    expect(await runSkills(['skills', 'find'], all.io)).toBe(0)
    expect(all.text()).toContain('vercel-labs/skills/find-skills · 3.5M')
    expect(all.text()).toContain('milo skills add https://skills.sh/vercel-labs/skills/find-skills')

    const filtered = capture()
    expect(await runSkills(['skills', 'find', 'grill'], filtered.io)).toBe(0)
    expect(filtered.text()).toContain('mattpocock/skills/grill-me')
    expect(filtered.text()).not.toContain('find-skills')
  })

  it('says so when the directory cannot be read', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }))
    const run = capture()

    expect(await runSkills(['skills', 'find'], run.io)).toBe(1)

    expect(run.errorText()).toContain('Could not read https://skills.sh')
  })
})

describe('parseLeaderboard', () => {
  it('reads the ranking from the links, in order, with what each row prints', () => {
    // Real shapes: the anchors are the ranking; `/agent/...` is a two-segment
    // route, `/site/...` is a host the page lists, and the same skill is linked
    // more than once.
    expect(parseLeaderboard(LEADERBOARD)).toEqual([
      {
        name: 'find-skills',
        repo: 'vercel-labs/skills',
        source: 'https://skills.sh/vercel-labs/skills/find-skills',
        installs: '3.5M',
      },
      {
        name: 'grill-me',
        repo: 'mattpocock/skills',
        source: 'https://skills.sh/mattpocock/skills/grill-me',
        installs: '1.2M',
      },
      // A row with no install count still comes through, without inventing one.
      { name: 'shadcn', repo: 'shadcn/ui', source: 'https://skills.sh/shadcn/ui/shadcn' },
    ])
  })

  it('reads the summary line of a skill page', () => {
    const page =
      '<div><h2>Installation</h2></div><h2>Summary</h2><p><strong>Discover and install ' +
      'specialized skills</strong> when users need them.</p><p>more</p>'

    expect(parseSummary(page)).toBe('Discover and install specialized skills')
    expect(parseSummary('<h2>Installation</h2>')).toBeUndefined()
  })
})

/** The shapes the real page has: a row's heading, repository and install count. */
function row(owner: string, repo: string, name: string, installs?: string): string {
  return (
    `<a class="row" href="/${owner}/${repo}/${name}">` +
    '<div><span>1</span></div>' +
    `<div><h3 class="font-semibold">${name}</h3><p class="font-mono">${owner}/${repo}</p></div>` +
    (installs
      ? `<div><span class="font-mono text-sm text-foreground">${installs}</span></div>`
      : '<div></div>') +
    '</a>'
  )
}

/** A page with the shapes the real one has, and the noise it also has. */
const LEADERBOARD = [
  row('vercel-labs', 'skills', 'find-skills', '3.5M'),
  '<a href="https://www.skills.sh/agent/claude-code"><img alt="Claude Code"></a>',
  row('mattpocock', 'skills', 'grill-me', '1.2M'),
  row('vercel-labs', 'skills', 'find-skills', '3.5M'),
  '<a href="https://www.skills.sh/site/open.feishu.cn/lark-doc">lark-doc</a>',
  '<a href="/shadcn/ui/shadcn">shadcn</a>',
  '<a href="https://www.skills.sh/p/some-pack">a pack</a>',
].join('\n')

/** Answers the GitHub tree API and the raw files it names. */
function githubFetch(skills: string[]) {
  return async (input: string | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tree: skills.map((name) => ({ path: `skills/${name}/SKILL.md`, type: 'blob' })),
        }),
        { status: 200 },
      )
    }
    const name = skills.find((candidate) => url.includes(`/${candidate}/`)) ?? skills[0]!
    return new Response(skillFile(name, `The ${name} skill`), { status: 200 })
  }
}
