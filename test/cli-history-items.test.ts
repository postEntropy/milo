import { describe, expect, it } from 'vitest'
import type { Message } from '../src/core/providers/types.js'
import { itemsFromMessages } from '../src/gateways/cli/history-items.js'

describe('itemsFromMessages', () => {
  it('skips internal messages and uses displayText with attachment notes and media notices', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'extracted pdf dump' },
          { type: 'image', mimeType: 'image/png', path: '/tmp/shot.png', name: 'shot.png' },
          { type: 'image', mimeType: 'image/png', path: '/tmp/page1.png', name: 'page1.png', derivedFromDocument: true },
          { type: 'document', mimeType: 'application/pdf', path: '/tmp/spec.pdf', name: 'spec.pdf' },
        ],
        displayText: 'Check this spec',
        mediaNotices: ['Page 2 was skipped'],
      },
      {
        role: 'user',
        internal: 'verification',
        content: [{ type: 'text', text: 'Run checks' }],
      },
    ]

    expect(itemsFromMessages(messages)).toEqual([
      { kind: 'user', text: 'Check this spec\n[image: shot.png] [file: spec.pdf]' },
      { kind: 'info', text: '⚠ Page 2 was skipped' },
    ])
  })

  it('pairs tool-call with tool-result, change counts, and tool display levels', () => {
    const change = [
      {
        path: 'a.ts',
        additions: 2,
        deletions: 1,
        lines: [{ kind: 'add' as const, text: 'const x = 1', new: 1 }],
      },
    ]
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Editing now.' },
          { type: 'tool-call', id: 'c1', name: 'edit_file', args: { path: 'a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', id: 'c1', name: 'edit_file', content: 'Edited a.ts', change }],
      },
    ]

    expect(itemsFromMessages(messages, { tools: 'full', thinking: 'expanded' })).toEqual([
      { kind: 'assistant', text: 'Editing now.' },
      {
        kind: 'tool',
        name: 'edit_file',
        detail: 'a.ts',
        ok: true,
        counts: '+2 −1',
        args: { path: 'a.ts' },
        result: 'Edited a.ts',
        change,
      },
    ])

    expect(itemsFromMessages(messages, { tools: 'name', thinking: 'expanded' })).toEqual([
      { kind: 'assistant', text: 'Editing now.' },
      { kind: 'tool', name: 'edit_file', detail: '', ok: true },
    ])

    expect(itemsFromMessages(messages, { tools: 'off', thinking: 'expanded' })).toEqual([
      { kind: 'assistant', text: 'Editing now.' },
    ])
  })

  it('keeps tool failures visible even when tools are off or quiet, but omits retired tool failures', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1', name: 'shell_command', args: { command: 'npm test' } },
          { type: 'tool-call', id: 'c2', name: 'todo', args: { todos: [{ content: 'Step', status: 'pending' }] } },
          { type: 'tool-call', id: 'c3', name: 'render_ui', args: { tree: { kind: 'text', text: 'hi' } } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', id: 'c1', name: 'shell_command', content: 'exit 1', isError: true },
          { type: 'tool-result', id: 'c2', name: 'todo', content: 'failed', isError: true },
          { type: 'tool-result', id: 'c3', name: 'render_ui', content: 'removed', isError: true },
        ],
      },
    ]

    expect(itemsFromMessages(messages, { tools: 'off', thinking: 'expanded' })).toEqual([
      { kind: 'tool', name: 'shell_command', detail: 'npm test', ok: false },
      { kind: 'todo', items: [{ content: 'Step', status: 'pending' }] },
      { kind: 'tool', name: 'todo', detail: '', ok: false },
      { kind: 'ui', summary: 'hi' },
    ])
  })

  it('respects thinking display and thoughtMs, plus genui fences, panel, and verification', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        thoughtMs: 2400,
        content: [
          { type: 'reasoning', text: 'weighing options' },
          {
            type: 'text',
            text: 'Here is the plan:\n\n```genui\n{"title":"Status","tree":{"kind":"badge","label":"Ready","tone":"ok"}}\n```\n\nDone.',
          },
          { type: 'tool-call', id: 'p1', name: 'panel', args: { path: 'src/index.ts', title: 'Entry' } },
        ],
        verification: { ok: true, text: 'Checks passed' },
      },
    ]

    expect(itemsFromMessages(messages, { tools: 'full', thinking: 'expanded' })).toEqual([
      { kind: 'reasoning', header: '✻ Thought for 2.4s', text: 'weighing options' },
      { kind: 'assistant', text: 'Here is the plan:\n\n' },
      { kind: 'ui', title: 'Status', summary: 'Ready' },
      { kind: 'assistant', text: '\nDone.' },
      { kind: 'panel', detail: 'Opened panel: Entry (src/index.ts)' },
      { kind: 'verification', ok: true, text: 'Checks passed' },
    ])

    expect(itemsFromMessages(messages, { tools: 'full', thinking: 'collapsed' })[0]).toEqual({
      kind: 'reasoning',
      header: '✻ Thought for 2.4s',
      text: '',
    })
  })

  it('hydrates routine deliveries with their header and delivered files', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        routine: { name: 'Morning digest', at: 1000 },
        content: [
          { type: 'text', text: 'All clear.' },
          { type: 'file', path: '/tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' },
        ],
      },
    ]

    expect(itemsFromMessages(messages)).toEqual([
      { kind: 'info', text: '⏱ Routine: Morning digest' },
      { kind: 'assistant', text: 'All clear.' },
      { kind: 'info', text: '[file: report.pdf]' },
    ])
  })
})
