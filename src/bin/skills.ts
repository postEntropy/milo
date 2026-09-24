import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { BUILTIN_SKILLS, SUGGESTED_SOURCES } from '../core/skills/builtin.js'
import { SKILLS_DIRECTORY, fetchLeaderboard, type PopularSkill } from '../core/skills/catalog.js'
import {
  installSkill,
  listInstalled,
  removeSkill,
  skillsDirFor,
  type InstalledSkill,
  type SkillScope,
} from '../core/skills/install.js'
import { resolveSource, type ResolvedSkill } from '../core/skills/sources.js'
import { errorMessage } from '../util/errors.js'

export interface SkillsIo {
  out(line: string): void
  err(line: string): void
  confirm(question: string): Promise<boolean>
  cwd: string
}

const USAGE = [
  'Usage:',
  '  milo skills                 what is installed',
  '  milo skills available       the skills that ship with Milo',
  '  milo skills find [query]    the most-installed in the directory',
  '  milo skills add <source>    a path, an http(s) URL, or owner/repo',
  '  milo skills remove <name>   delete one',
  '',
  'Options:',
  '  --skill <name>   take one skill from a source that holds several',
  '  --project        use <cwd>/.milo/skills instead of ~/.milo/skills',
  '  --yes            skip the confirmation',
].join('\n')

/**
 * `milo skills`. A terminal command, not a screen: it prints what it did and
 * exits, and never touches the network to decide anything by itself.
 *
 * Installing is a human act on purpose. There is no tool that lets the model do
 * it — a skill is instructions, and something that can install instructions is
 * something that can escalate with them.
 */
export async function runSkills(argv: string[], io: Partial<SkillsIo> = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  const cwd = io.cwd ?? process.cwd()
  const confirm = io.confirm ?? askOnTty

  const args = argv[0] === 'skills' ? argv.slice(1) : argv
  let parsed: Parsed
  try {
    parsed = parseFlags(args)
  } catch (error) {
    err(errorMessage(error))
    err(USAGE)
    return 1
  }

  const scope: SkillScope = parsed.project ? 'project' : 'global'
  const dir = skillsDirFor(scope, cwd)
  const [command, ...rest] = parsed.positionals

  try {
    switch (command ?? 'list') {
      case 'list':
        return list(out, cwd, parsed.project)
      case 'available':
        return available(out, cwd)
      case 'find':
        return await find(rest[0], out, err)
      case 'add':
        return await add(rest[0], parsed, { out, err, confirm, cwd, dir })
      case 'remove':
      case 'rm':
        return remove(rest[0], out, err, dir)
      case 'help':
        out(USAGE)
        return 0
      default:
        err(`Unknown: milo skills ${command}`)
        err(USAGE)
        return 1
    }
  } catch (error) {
    err(errorMessage(error))
    return 1
  }
}

interface Parsed {
  positionals: string[]
  yes: boolean
  project: boolean
  skill?: string
}

function parseFlags(argv: string[]): Parsed {
  const parsed: Parsed = { positionals: [], yes: false, project: false }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--yes' || token === '-y') parsed.yes = true
    else if (token === '--project' || token === '-p') parsed.project = true
    else if (token === '--skill' || token === '-s') {
      const value = argv[++i]
      if (!value) throw new Error('--skill needs a name.')
      parsed.skill = value
    } else if (token.startsWith('-')) throw new Error(`Unknown option ${token}.`)
    else parsed.positionals.push(token)
  }
  return parsed
}

function list(out: SkillsIo['out'], cwd: string, projectOnly: boolean): number {
  const scopes: SkillScope[] = projectOnly ? ['project'] : ['global', 'project']
  let total = 0

  for (const scope of scopes) {
    const dir = skillsDirFor(scope, cwd)
    const skills = listInstalled(dir)
    total += skills.length
    out(`${scope === 'global' ? 'global' : 'this project'} — ${dir}`)
    if (skills.length === 0) {
      out('  (none)')
      continue
    }
    for (const skill of skills) for (const line of describe(skill)) out(line)
  }

  if (total === 0) {
    out('')
    out('Nothing installed. `milo skills available` lists the ones that ship with Milo;')
    out(`browse ${SKILLS_DIRECTORY} and \`milo skills add <page-url>\` for anything else.`)
  }
  return 0
}

/** A skill as two lines: what it is, and where it came from. */
function describe(skill: InstalledSkill): string[] {
  const lines = [`  ${skill.name} — ${skill.description}`]
  // A skill put there by hand has no provenance to report, and inventing one
  // would be worse than saying so.
  lines.push(
    skill.origin
      ? `    from ${skill.origin}${skill.installedAt ? `, ${skill.installedAt.slice(0, 10)}` : ''}`
      : '    added by hand',
  )
  return lines
}

function available(out: SkillsIo['out'], cwd: string): number {
  const installed = new Set(
    (['global', 'project'] as SkillScope[])
      .flatMap((scope) => listInstalled(skillsDirFor(scope, cwd)))
      .map((skill) => skill.name),
  )

  out('Ships with Milo:')
  for (const skill of BUILTIN_SKILLS) {
    out(`  ${skill.name} — ${skill.description}${installed.has(skill.name) ? '  (installed)' : ''}`)
  }

  out('')
  // Named, not fetched: nothing here has been reviewed by Milo, and the ecosystem
  // itself says it cannot vouch for what a listed skill does.
  out('Suggested, from the open ecosystem — not reviewed by Milo:')
  for (const suggestion of SUGGESTED_SOURCES) {
    out(`  ${suggestion.name} — ${suggestion.note}`)
    out(`    milo skills add ${suggestion.source}`)
  }

  out('')
  out(
    `\`milo skills find\` lists the most-installed in the directory; \`milo skills add\` takes any of its pages.`,
  )
  return 0
}

/**
 * The directory's ranking, read live. The page is already ranked, so the order
 * of what comes back is the order to print — there is nothing to sort.
 */
async function find(
  query: string | undefined,
  out: SkillsIo['out'],
  err: SkillsIo['err'],
): Promise<number> {
  let popular: PopularSkill[]
  try {
    popular = await fetchLeaderboard(50)
  } catch (error) {
    err(`Could not read ${SKILLS_DIRECTORY}: ${errorMessage(error)}`)
    return 1
  }

  const matches = query
    ? popular.filter((entry) =>
        `${entry.repo}/${entry.name}`.toLowerCase().includes(query.toLowerCase()),
      )
    : popular

  if (matches.length === 0) {
    out(`Nothing matching "${query}" among the ${popular.length} most installed.`)
    return 0
  }

  out(`Most installed in ${SKILLS_DIRECTORY}${query ? `, matching "${query}"` : ''}:`)
  for (const entry of matches.slice(0, 20)) {
    out(`  ${entry.repo}/${entry.name}${entry.installs ? ` · ${entry.installs}` : ''}`)
    out(`    milo skills add ${entry.source}`)
  }
  return 0
}

interface AddContext {
  out: SkillsIo['out']
  err: SkillsIo['err']
  confirm: SkillsIo['confirm']
  cwd: string
  dir: string
}

async function add(source: string | undefined, flags: Parsed, context: AddContext): Promise<number> {
  if (!source) {
    context.err('Usage: milo skills add <source>')
    return 1
  }

  // A bare word is a built-in by name; anything with a slash, a scheme or a dot
  // prefix is a source, and goes to the resolver.
  const builtin = /^[\w.-]+$/.test(source)
    ? BUILTIN_SKILLS.find((skill) => skill.name === source)
    : undefined
  // A lookup is a round trip — two, for a repository. Naming it where the wait
  // is what makes it a wait instead of looking hung.
  if (!builtin && looksRemote(source)) context.out(`Looking up ${source}…`)

  const candidates: ResolvedSkill[] = builtin
    ? [builtin]
    : await resolveSource(source, { cwd: context.cwd, skill: flags.skill })

  if (candidates.length > 1) {
    context.out(`${source} holds ${candidates.length} skills. Take one with --skill:`)
    for (const candidate of candidates) {
      context.out(`  ${candidate.name} — ${candidate.description}`)
    }
    return 0
  }

  const skill = candidates[0]!
  context.out(`  ${skill.name} — ${skill.description}`)
  context.out(`  from ${skill.origin}`)
  context.out(`  ${skill.markdown.length} bytes → ${path.join(context.dir, skill.name, 'SKILL.md')}`)
  context.out('')

  if (!flags.yes && !(await context.confirm('Install it? [y/N] '))) {
    context.out('Nothing installed.')
    return 0
  }

  const { file, replaced } = await installSkill(skill, context.dir)
  context.out(`${replaced ? 'Replaced' : 'Installed'} ${skill.name} — ${file}`)
  context.out('Restart milo to pick it up.')
  return 0
}

/** Whether a source has to go to the network: a URL, or `owner/repo`. */
function looksRemote(source: string): boolean {
  return /^https?:\/\//i.test(source) || /^[\w.-]+\/[\w.-]+$/.test(source)
}

function remove(
  name: string | undefined,
  out: SkillsIo['out'],
  err: SkillsIo['err'],
  dir: string,
): number {
  if (!name) {
    err('Usage: milo skills remove <name>')
    return 1
  }
  if (!removeSkill(name, dir)) {
    err(`No skill "${name}" in ${dir}.`)
    return 1
  }
  out(`Removed ${name}.`)
  return 0
}

/**
 * Asks, unless there is nobody to ask. A piped `milo skills add` must not
 * install by assuming the answer — a bare Enter is a no, and no terminal at all
 * is a no too.
 */
async function askOnTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await readline.question(question)).trim())
  } finally {
    readline.close()
  }
}
