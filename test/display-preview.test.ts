import { describe, expect, it } from 'vitest'
import { previewTurn, type PreviewMessage, type PreviewTools } from '../web/src/settings/preview-turn.js'

/** Stands in for the chat's `toolText`: the name, plus the command when given. */
function line(name: string, args?: unknown): string {
  const command = args && typeof args === 'object' ? (args as { command?: string }).command : undefined
  return command ? `${name} ${command}` : name
}

function assistantParts(tools: PreviewTools): PreviewMessage['parts'] {
  return previewTurn(tools, line).find((message) => message.role === 'assistant')?.parts ?? []
}

describe('the Display preview', () => {
  it('draws the call with its whole command at full detail', () => {
    expect(assistantParts('full')).toContainEqual({ kind: 'tool', tool: { name: 'shell_command', text: 'shell_command npm test -- --coverage' } })
  })

  it('keeps only the tool name at name detail', () => {
    expect(assistantParts('name')).toContainEqual({ kind: 'tool', tool: { name: 'shell_command', text: 'shell_command' } })
  })

  it('leaves the call out entirely when detail is off, keeping the prose around it', () => {
    const parts = assistantParts('off')
    expect(parts.some((part) => part.kind === 'tool')).toBe(false)
    expect(parts.filter((part) => part.kind === 'text')).toHaveLength(2)
  })
})
