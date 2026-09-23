import { describe, expect, it } from 'vitest'
import { readFileTool } from '../src/core/tools/read-file.js'
import { ctxFor, makeTree } from './tree.js'

describe('read_file', () => {
  it('numbers lines and stops counting the trailing newline as a line', async () => {
    const tree = makeTree({ 'a.txt': 'one\ntwo\nthree\n' })
    try {
      const result = await readFileTool.execute({ path: 'a.txt' }, ctxFor(tree.root))
      expect(result.content).toBe('1\tone\n2\ttwo\n3\tthree')
      expect(result.content).not.toContain('4\t')
    } finally {
      tree.cleanup()
    }
  })

  it('says an empty file is empty', async () => {
    const tree = makeTree({ 'empty.txt': '' })
    try {
      const result = await readFileTool.execute({ path: 'empty.txt' }, ctxFor(tree.root))
      expect(result.content).toBe('(empty file)')
    } finally {
      tree.cleanup()
    }
  })

  it('starts at the requested offset', async () => {
    const tree = makeTree({ 'a.txt': 'one\ntwo\nthree\n' })
    try {
      const result = await readFileTool.execute({ path: 'a.txt', offset: 2 }, ctxFor(tree.root))
      expect(result.content).toBe('2\ttwo\n3\tthree')
    } finally {
      tree.cleanup()
    }
  })

  it('reports a line past the end instead of calling the file empty', async () => {
    const tree = makeTree({ 'a.txt': 'one\ntwo\n' })
    try {
      const result = await readFileTool.execute({ path: 'a.txt', offset: 99 }, ctxFor(tree.root))
      expect(result.isError).toBe(true)
      expect(result.content).toContain('past the end')
      expect(result.content).toContain('2 line(s)')
      expect(result.content).not.toContain('(empty file)')
    } finally {
      tree.cleanup()
    }
  })

  it('names how many lines are left and where to continue', async () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n')
    const tree = makeTree({ 'a.txt': `${lines}\n` })
    try {
      const result = await readFileTool.execute({ path: 'a.txt', limit: 4 }, ctxFor(tree.root))
      expect(result.content).toContain('4\tline 4')
      expect(result.content).not.toContain('line 5')
      expect(result.content).toContain('6 more line(s)')
      expect(result.content).toContain('offset=5')
    } finally {
      tree.cleanup()
    }
  })

  it('cuts between lines when the character budget runs out, and says where', async () => {
    // Each line is 100 characters, so 40k characters is about 400 lines.
    const wide = Array.from({ length: 900 }, (_, index) => `${index + 1}:${'x'.repeat(96)}`).join('\n')
    const tree = makeTree({ 'wide.txt': wide })
    try {
      const result = await readFileTool.execute({ path: 'wide.txt' }, ctxFor(tree.root))
      const body = result.content.split('\n… ')[0]!
      const numbered = body.split('\n')
      // Every returned line is whole, and the next line is named rather than
      // half-included.
      for (const [index, line] of numbered.entries()) {
        expect(line).toBe(`${index + 1}\t${index + 1}:${'x'.repeat(96)}`)
      }
      expect(result.content).toContain(`offset=${numbered.length + 1}`)
      expect(result.content).toContain(`${900 - numbered.length} more line(s)`)
    } finally {
      tree.cleanup()
    }
  })

  it('clips a single line that is longer than the whole budget', async () => {
    const tree = makeTree({ 'min.js': `var a=1;${'y'.repeat(60_000)}` })
    try {
      const result = await readFileTool.execute({ path: 'min.js' }, ctxFor(tree.root))
      expect(result.content.length).toBeLessThan(41_000)
      expect(result.content).toContain('…')
    } finally {
      tree.cleanup()
    }
  })

  it('fails cleanly on a missing file', async () => {
    const tree = makeTree({ 'a.txt': 'one' })
    try {
      const result = await readFileTool.execute({ path: 'nope.txt' }, ctxFor(tree.root))
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Failed to read')
    } finally {
      tree.cleanup()
    }
  })
})
