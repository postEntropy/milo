import { describe, expect, it } from 'vitest'
import { previewTurn, type PreviewMessage, type PreviewTools } from '../web/src/settings/preview-turn.js'

function assistantParts(tools: PreviewTools): PreviewMessage['parts'] {
  return previewTurn(tools).find((message) => message.role === 'assistant')?.parts ?? []
}

describe('the Display preview', () => {
  it('draws the call with its whole command at full detail', () => {
    expect(assistantParts('full')).toContainEqual({
      kind: 'tool',
      tool: { name: 'shell_command', text: 'shell_command npm test -- --coverage', state: 'running' },
    })
  })

  it('keeps only the tool name at name detail', () => {
    expect(assistantParts('name')).toContainEqual({
      kind: 'tool',
      tool: { name: 'shell_command', text: 'shell_command', state: 'running' },
    })
  })

  it('leaves the call out entirely when detail is off, keeping the prose', () => {
    const parts = assistantParts('off')
    expect(parts.some((part) => part.kind === 'tool')).toBe(false)
    expect(parts.filter((part) => part.kind === 'text')).toHaveLength(1)
  })

  it('draws its one call as a line, not as a thread', async () => {
    // The preview is the chat's own renderer over the same parts, so a sample with
    // one call has to group the way the chat would group it.
    const { toolRows } = await import('../web/src/chat/tool-runs.js')
    const keyed = assistantParts('full').map((part, index) => ({ part, key: `part-${index}` }))

    expect(toolRows(keyed).filter((row) => row.kind === 'spine')).toEqual([])
  })
})
