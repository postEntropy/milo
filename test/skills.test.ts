import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/core/agent/system.js'
import { discoverSkills, formatSkillList, parseSkill, type Skill } from '../src/core/skills/index.js'
import { createReadSkillTool } from '../src/core/tools/read-skill.js'
import { createToolRegistry } from '../src/core/tools/index.js'
import { makeTree, type Tree } from './tree.js'

let tree: Tree

afterEach(() => tree?.cleanup())

/** One `SKILL.md` body, frontmatter included. */
function skillFile(name: string, description: string, body = 'Do the thing.'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

function nameOf(skill: Skill): string {
  return skill.name
}

describe('parseSkill', () => {
  it('reads the name, the description and the body', () => {
    const skill = parseSkill(skillFile('deploy', 'How to deploy'), {
      fallbackName: 'ignored',
      path: '/skills/deploy/SKILL.md',
      source: 'global',
    })

    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('deploy')
    expect(skill!.description).toBe('How to deploy')
    expect(skill!.body).toBe('Do the thing.')
  })

  it('falls back to the directory name when the frontmatter omits one', () => {
    const skill = parseSkill('---\ndescription: no name here\n---\nbody', {
      fallbackName: 'from-dir',
      path: '/x/SKILL.md',
      source: 'project',
    })

    expect(skill!.name).toBe('from-dir')
  })

  it('strips quotes around a value', () => {
    const skill = parseSkill('---\nname: "quoted"\ndescription: \'also quoted\'\n---\nbody', {
      fallbackName: 'x',
      path: '/x/SKILL.md',
      source: 'global',
    })

    expect(skill!.name).toBe('quoted')
    expect(skill!.description).toBe('also quoted')
  })

  it('drops a skill with no description — it cannot be indexed', () => {
    const skill = parseSkill('---\nname: nameless\n---\nbody', {
      fallbackName: 'x',
      path: '/x/SKILL.md',
      source: 'global',
    })

    expect(skill).toBeNull()
  })

  it('treats an unterminated frontmatter as body, not a header', () => {
    const skill = parseSkill('---\nname: x\ndescription: y\nbody with no closing fence', {
      fallbackName: 'x',
      path: '/x/SKILL.md',
      source: 'global',
    })

    expect(skill).toBeNull()
  })
})

describe('discoverSkills', () => {
  it('finds one SKILL.md per directory', () => {
    tree = makeTree({
      'global/alpha/SKILL.md': skillFile('alpha', 'the first'),
      'global/beta/SKILL.md': skillFile('beta', 'the second'),
    })

    const skills = discoverSkills([{ dir: path.join(tree.root, 'global'), source: 'global' }])

    expect(skills.map(nameOf)).toEqual(['alpha', 'beta'])
    expect(skills[0]?.source).toBe('global')
  })

  it('lets a later source win a name it shares with an earlier one', () => {
    tree = makeTree({
      'global/alpha/SKILL.md': skillFile('alpha', 'from global'),
      'project/alpha/SKILL.md': skillFile('alpha', 'from project'),
    })

    const skills = discoverSkills([
      { dir: path.join(tree.root, 'global'), source: 'global' },
      { dir: path.join(tree.root, 'project'), source: 'project' },
    ])

    expect(skills).toHaveLength(1)
    expect(skills[0]?.description).toBe('from project')
    expect(skills[0]?.source).toBe('project')
  })

  it('skips a directory with no SKILL.md and one with no description', () => {
    tree = makeTree({
      'global/readme-only/notes.md': 'x',
      'global/nameless/SKILL.md': '---\nname: nameless\n---\nbody',
    })

    const skills = discoverSkills([{ dir: path.join(tree.root, 'global'), source: 'global' }])

    expect(skills).toEqual([])
  })

  it('is not an error when the directory does not exist', () => {
    expect(discoverSkills([{ dir: '/nope/definitely/missing', source: 'global' }])).toEqual([])
  })
})

describe('read_skill tool', () => {
  function oneSkill(): Skill {
    tree = makeTree({ 'global/deploy/SKILL.md': skillFile('deploy', 'How to deploy', 'Run the pipeline.') })
    return discoverSkills([{ dir: path.join(tree.root, 'global'), source: 'global' }])[0]!
  }

  it('returns the instructions by name', async () => {
    const tool = createReadSkillTool([oneSkill()])

    const result = await tool.execute({ name: 'deploy' }, { cwd: '.', signal: new AbortController().signal })

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('Run the pipeline.')
  })

  it('lists what is available when the name is unknown', async () => {
    const tool = createReadSkillTool([oneSkill()])

    const result = await tool.execute({ name: 'nope' }, { cwd: '.', signal: new AbortController().signal })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('deploy')
  })

  it('re-reads the body from disk, so an edit lands without a restart', async () => {
    const skill = oneSkill()
    const tool = createReadSkillTool([skill])
    writeFileSync(skill.path, skillFile('deploy', 'How to deploy', 'A brand new body.'))

    const result = await tool.execute({ name: 'deploy' }, { cwd: '.', signal: new AbortController().signal })

    expect(result.content).toContain('A brand new body.')
  })

  it('is read-only, so it never asks for confirmation', () => {
    expect(createReadSkillTool([oneSkill()]).readOnly).toBe(true)
  })
})

describe('system prompt', () => {
  const base = {
    base: 'You are Milo.',
    cwd: '/tmp',
    provider: 'openai',
    model: 'gpt',
    tools: [],
    memories: [],
  }

  it('indexes the skills when there are any', () => {
    const prompt = buildSystemPrompt({
      ...base,
      skills: [{ name: 'deploy', description: 'How to deploy' }],
    })

    expect(prompt).toContain('## Skills')
    expect(prompt).toContain('- deploy: How to deploy')
    // The index says it is the whole set, without exposing machine paths, so
    // the model answers "what do you have?" from context instead of going to look.
    expect(prompt).toContain('the whole inventory')
    expect(prompt).not.toContain(path.join('/tmp', '.milo', 'skills'))
    expect(prompt).toContain('other agents do not count')
  })

  it('omits the section when there are none', () => {
    expect(buildSystemPrompt(base)).not.toContain('## Skills')
    expect(buildSystemPrompt({ ...base, skills: [] })).not.toContain('## Skills')
  })
})

describe('createToolRegistry', () => {
  it('registers `read_skill` only when skills are present', () => {
    expect(createToolRegistry().has('read_skill')).toBe(false)
    expect(createToolRegistry({ skills: [] }).has('read_skill')).toBe(false)

    const skill: Skill = {
      name: 'deploy',
      description: 'How to deploy',
      body: 'x',
      path: '/x/SKILL.md',
      source: 'global',
    }
    expect(createToolRegistry({ skills: [skill] }).has('read_skill')).toBe(true)
  })
})

describe('formatSkillList', () => {
  it('names each skill and says how to add one when there are none', () => {
    expect(formatSkillList([])).toContain('No skills found')
    expect(formatSkillList([{ name: 'deploy', description: 'How to deploy' }])).toContain(
      '- deploy — How to deploy',
    )
  })
})
