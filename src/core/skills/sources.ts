import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseSkill } from './index.js'

/** A skill read from somewhere, ready to be written. */
export interface ResolvedSkill {
  name: string
  description: string
  /** The source's own bytes, kept whole: its frontmatter fields are not ours to drop. */
  markdown: string
  /** Where it came from — a path, a URL, or `owner/repo` — for the confirmation and the sidecar. */
  origin: string
}

export interface ResolveOptions {
  cwd: string
  /** Take only the skill whose directory is named this. */
  skill?: string
  signal?: AbortSignal
}

/**
 * The ecosystem's own ceiling for a downloaded skill. A `SKILL.md` is a page of
 * instructions; anything past this is not one, and reading it into memory to
 * find that out is the thing the limit is for.
 */
const MAX_BYTES = 10 * 1024 * 1024
const TIMEOUT_MS = 20_000

/**
 * Turns a source into the skills it holds. Four shapes, in the order they are
 * tried: a local path, `owner/repo` (or a GitHub or skills.sh URL), a direct
 * http(s) URL to one `SKILL.md`, and nothing else.
 *
 * The registry form resolves from git — `skills.sh` is a directory of pages, not
 * an API of skills — which is why a repository yields a *list*: one repo can
 * hold many skills, and choosing between them is the caller's business.
 */
export async function resolveSource(
  source: string,
  options: ResolveOptions,
): Promise<ResolvedSkill[]> {
  const wanted = source.trim()
  if (!wanted) throw new Error('No source given.')

  const local = localPath(wanted, options.cwd)
  if (local) return [readLocal(local)]

  const target = githubTarget(wanted)
  if (target) return await fromGithub(target, options)

  if (/^https?:\/\//i.test(wanted)) return [await fromUrl(wanted, options.signal)]

  throw new Error(
    `Cannot tell where "${wanted}" points. Give a local path, an http(s) URL, or owner/repo.`,
  )
}

/** A path the user clearly meant, or one that happens to exist. */
function localPath(source: string, cwd: string): string | null {
  const expanded = source.startsWith('~') ? path.join(homedir(), source.slice(1)) : source
  const resolved = path.resolve(cwd, expanded)
  const looksLikePath = source.startsWith('.') || source.startsWith('/') || source.startsWith('~')

  if (looksLikePath) {
    if (!existsSync(resolved)) throw new Error(`No such path: ${source}`)
    return resolved
  }
  return existsSync(resolved) ? resolved : null
}

function readLocal(target: string): ResolvedSkill {
  const isDirectory = statSync(target).isDirectory()
  const file = isDirectory ? path.join(target, 'SKILL.md') : target
  if (!existsSync(file)) throw new Error(`No SKILL.md at ${target}`)

  const fallbackName = isDirectory ? path.basename(target) : path.basename(path.dirname(target))
  return skillFrom(readFileSync(file, 'utf8'), fallbackName, target)
}

interface GithubTarget {
  owner: string
  repo: string
  /** A ref from a tree URL; the default branch otherwise. */
  ref?: string
  /** A directory inside the repo, from a tree URL. */
  path?: string
  /** A single skill named by a skills.sh URL. */
  skill?: string
}

const SHORTHAND = /^([\w.-]+)\/([\w.-]+)$/

/**
 * Reads the shapes that name a repository: `owner/repo`, a `github.com` URL
 * (optionally a `/tree/<ref>/<dir>` one) and a `skills.sh` page, which encodes
 * the same `owner/repo` in its path.
 */
function githubTarget(source: string): GithubTarget | null {
  const shorthand = SHORTHAND.exec(source)
  if (shorthand) return { owner: shorthand[1]!, repo: stripGit(shorthand[2]!) }

  let url: URL
  try {
    url = new URL(source)
  } catch {
    return null
  }

  const host = url.hostname.replace(/^www\./, '')
  const parts = url.pathname.split('/').filter(Boolean)

  if (host === 'github.com' && parts.length >= 2) {
    const owner = parts[0]!
    const repo = stripGit(parts[1]!)
    if (parts[2] === 'tree' && parts[3]) {
      return { owner, repo, ref: parts[3], path: parts.slice(4).join('/') || undefined }
    }
    return { owner, repo }
  }

  if (host === 'skills.sh') {
    // `/b/<owner>/<repo>` is the badge URL; `/p/<id>` is a pack, a different thing.
    const rest = parts[0] === 'b' ? parts.slice(1) : parts
    if (rest[0] === 'p') throw new Error('Skill packs are not supported yet — use the repo they point at.')
    if (rest.length >= 2) {
      return { owner: rest[0]!, repo: stripGit(rest[1]!), skill: rest[2] }
    }
  }

  return null
}

function stripGit(name: string): string {
  return name.replace(/\.git$/, '')
}

async function fromGithub(
  target: GithubTarget,
  options: ResolveOptions,
): Promise<ResolvedSkill[]> {
  const ref = target.ref ?? 'HEAD'
  const tree = await githubJson(
    `https://api.github.com/repos/${target.owner}/${target.repo}/git/trees/${ref}?recursive=1`,
    options.signal,
  )
  const wanted = options.skill ?? target.skill

  const paths = (tree.tree ?? [])
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path!)
    .filter((file) => file === 'SKILL.md' || file.endsWith('/SKILL.md'))
    .filter((file) => !target.path || file.startsWith(`${target.path}/`))
    .filter((file) => !wanted || skillNameFor(file, target.repo) === wanted)

  if (paths.length === 0) {
    throw new Error(
      wanted
        ? `No skill named "${wanted}" in ${target.owner}/${target.repo}.`
        : `No SKILL.md in ${target.owner}/${target.repo}.`,
    )
  }

  const origin = target.path
    ? `https://github.com/${target.owner}/${target.repo}/tree/${ref}/${target.path}`
    : `https://github.com/${target.owner}/${target.repo}`

  const skills: ResolvedSkill[] = []
  for (const file of paths) {
    const raw = `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${ref}/${file}`
    skills.push(skillFrom(await fetchText(raw, options.signal), skillNameFor(file, target.repo), origin))
  }
  return skills
}

/** A `SKILL.md` at the repo root is the repo's own skill, so the repo names it. */
function skillNameFor(file: string, repo: string): string {
  const dir = path.posix.dirname(file)
  return dir === '.' ? repo : path.posix.basename(dir)
}

async function fromUrl(url: string, signal?: AbortSignal): Promise<ResolvedSkill> {
  const markdown = await fetchText(url, signal)
  const directory = path.posix.dirname(new URL(url).pathname)
  return skillFrom(markdown, path.posix.basename(directory) || 'skill', url)
}

/** Parses what was fetched, and refuses anything that is not a skill. */
function skillFrom(markdown: string, fallbackName: string, origin: string): ResolvedSkill {
  const parsed = parseSkill(markdown, { fallbackName, path: origin, source: 'imported' })
  if (!parsed) {
    throw new Error(`${origin} has no description in its frontmatter, so it is not a skill.`)
  }
  return { name: parsed.name, description: parsed.description, markdown, origin }
}

async function githubJson(
  url: string,
  signal?: AbortSignal,
): Promise<{ tree?: { path?: string; type?: string }[] }> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  return JSON.parse(await fetchText(url, signal, headers)) as {
    tree?: { path?: string; type?: string }[]
  }
}

export async function fetchText(
  url: string,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })

  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'milo', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) {
      // The anonymous GitHub API is 60 requests an hour, which a repo with many
      // skills can reach in one command — saying where the limit comes from is
      // the difference between a wall and a fix.
      const hint =
        response.status === 403 && url.includes('api.github.com')
          ? ' (the GitHub API allows 60 requests an hour without a token; set GITHUB_TOKEN)'
          : ''
      throw new Error(`${url} answered ${response.status}${hint}`)
    }

    const declared = Number(response.headers.get('content-length') ?? '0')
    if (declared > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES} bytes.`)
    const text = await response.text()
    if (text.length > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES} bytes.`)
    return text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
