import { fetchText } from './sources.js'

/** One entry of the directory's ranking. */
export interface PopularSkill {
  /** The name as the directory shows it. */
  name: string
  /** `owner/repo`. */
  repo: string
  /** The page, which `milo skills add` takes as it is. */
  source: string
  /** Installs as the directory prints them (`3.5M`). */
  installs?: string
  /** The one-line summary from the skill's own page, when it could be read. */
  description?: string
}

export const SKILLS_DIRECTORY = 'https://skills.sh'

/** The site's own routes, which are not skills however much they look like paths. */
const NOT_A_SKILL = new Set(['agent', 'agents', 'b', 'docs', 'hot', 'p', 'site', 'trending'])

/**
 * The ranking, each row decorated with the summary from its own page.
 *
 * The listing carries the name, the repository and the install count; the
 * summary is only on the skill's page, so it costs one more request each — which
 * is why a caller that does not need it asks `fetchLeaderboard` instead.
 */
export async function fetchPopular(limit: number, signal?: AbortSignal): Promise<PopularSkill[]> {
  const skills = await fetchLeaderboard(limit, signal)
  const summaries = await Promise.all(skills.map((skill) => fetchSummary(skill.source, signal)))
  return skills.map((skill, index) => ({ ...skill, description: summaries[index] }))
}

/**
 * The directory's ranking, top first — one request.
 *
 * `skills.sh` is a website, not an API, so this reads its page. It reads the
 * links, and inside each one the name, the repository and the install count:
 * the ranking *is* the order of the links, so nothing has to be sorted, and the
 * fields are the ones a row already prints.
 */
export async function fetchLeaderboard(
  limit: number,
  signal?: AbortSignal,
): Promise<PopularSkill[]> {
  return parseLeaderboard(await fetchText(SKILLS_DIRECTORY, signal)).slice(0, limit)
}

const ROW =
  /<a\b[^>]*href="(?:https?:\/\/(?:www\.)?skills\.sh)?\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)"[^>]*>([\s\S]*?)<\/a>/g
const HEADING = /<h3[^>]*>([\s\S]*?)<\/h3>/
const REPO = /<p[^>]*>([\s\S]*?)<\/p>/
const INSTALLS = /<span[^>]*class="[^"]*font-mono[^"]*text-foreground[^"]*"[^>]*>([^<]+)<\/span>/

/** Split out from the fetch so the parse can be tested against real markup. */
export function parseLeaderboard(html: string): PopularSkill[] {
  const found = new Map<string, PopularSkill>()

  for (const match of html.matchAll(ROW)) {
    const [, owner, repo, slug, body] = match
    if (!owner || !repo || !slug || !body) continue
    if (NOT_A_SKILL.has(owner.toLowerCase())) continue

    const source = `${SKILLS_DIRECTORY}/${owner}/${repo}/${slug}`
    if (found.has(source)) continue
    found.set(source, {
      // The heading is what a person reads; a row without one still has its slug.
      name: capture(body, HEADING) ?? slug,
      repo: capture(body, REPO) ?? `${owner}/${repo}`,
      source,
      installs: capture(body, INSTALLS),
    })
  }

  return [...found.values()]
}

/**
 * The `## Summary` line of a skill's page — the description its author wrote in
 * the frontmatter. Everything after the word Summary is searched, because the
 * heading is what marks the block and the markup around it is the site's to
 * change.
 */
export function parseSummary(html: string): string | undefined {
  const at = html.indexOf('>Summary<')
  const scope = at === -1 ? html : html.slice(at, at + 6000)
  const match = /<strong[^>]*>([\s\S]*?)<\/strong>/.exec(scope)
  if (!match) return undefined
  const summary = flatten(match[1]!)
  return summary.length > 0 && summary.length <= 400 ? summary : undefined
}

async function fetchSummary(source: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return parseSummary(await fetchText(source, signal))
  } catch {
    // A summary that could not be read is not a reason to lose the row.
    return undefined
  }
}

function capture(body: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(body)
  return match?.[1] ? flatten(match[1]) || undefined : undefined
}

/** Tags out, entities in, whitespace collapsed. */
function flatten(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
}

function decode(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
}
