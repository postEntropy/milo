import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import type { SessionSummary } from '../src/core/sessions/types.js'
import { FolderPicker } from '../src/gateways/cli/components/folder-picker.js'
import { MiloMark } from '../src/gateways/cli/components/milo-mark.js'
import { SessionPicker } from '../src/gateways/cli/components/session-picker.js'
import { theme } from '../src/gateways/cli/theme.js'

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

const UP = '\u001b[A'
const DOWN = '\u001b[B'
const ESC = '\u001b'
const CTRL_U = '\u0015'
const BACKSPACE = '\u007f'

async function send(stdin: { write: (data: string) => void }, seq: string): Promise<void> {
  stdin.write(seq)
  await tick()
}

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    messageCount: 4,
    preview: 'default preview',
    label: overrides.title ?? overrides.preview ?? 'default preview',
    ...overrides,
  }
}

afterEach(() => cleanup())

describe('SessionPicker', () => {
  const sessions: SessionSummary[] = [
    makeSession({
      id: 'calm-otter-7',
      title: 'Fix auth token refresh',
      preview: 'Look into token expiry',
      project: 'proj-api',
      updatedAt: Date.now() - 5 * 60_000,
    }),
    makeSession({
      id: 'brave-wolf-2',
      preview: 'Build the new TUI composer',
      project: 'proj-milo',
      updatedAt: Date.now() - 2 * 60 * 60_000,
    }),
    makeSession({
      id: 'bright-lynx-9',
      title: 'Database migration plan',
      preview: 'Add index on users',
      updatedAt: Date.now() - 24 * 60 * 60_000,
    }),
  ]
  const projectNames = { 'proj-api': 'api-server', 'proj-milo': 'milo' }

  it('renders session labels, relative times, project names, current marker, and no borders', () => {
    const { lastFrame } = render(
      <SessionPicker
        sessions={sessions}
        projectNames={projectNames}
        currentSessionId="brave-wolf-2"
        maxHeight={10}
        columns={90}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''

    expect(frame).toContain('Sessions (3)')
    expect(frame).toContain('calm-otter-7 — Fix auth token refresh')
    expect(frame).toContain('api-server')
    expect(frame).toContain('5 min ago')
    expect(frame).toContain('brave-wolf-2 — Build the new TUI composer')
    expect(frame).toContain('milo')
    expect(frame).toContain('current')
    expect(frame).not.toContain('─')
    expect(frame).not.toMatch(/[╭╰╮╯]/)
  })

  it('filters live by title, preview, id, and project, then selects with arrows and Enter', async () => {
    const onSelect = vi.fn()
    const { stdin, lastFrame } = render(
      <SessionPicker
        sessions={sessions}
        projectNames={projectNames}
        maxHeight={10}
        columns={90}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    )

    await send(stdin, 'milo')
    expect(lastFrame()).toContain('brave-wolf-2')
    expect(lastFrame()).not.toContain('calm-otter-7')

    await send(stdin, CTRL_U)
    await send(stdin, 'migration')
    expect(lastFrame()).toContain('bright-lynx-9')
    expect(lastFrame()).not.toContain('brave-wolf-2')

    await send(stdin, CTRL_U)
    await send(stdin, DOWN)
    await send(stdin, '\r')
    expect(onSelect).toHaveBeenCalledWith('brave-wolf-2')
  })

  it('shows an empty-filter notice when no sessions match and cancels on Esc', async () => {
    const onCancel = vi.fn()
    const { stdin, lastFrame } = render(
      <SessionPicker
        sessions={sessions}
        maxHeight={10}
        columns={80}
        onSelect={() => {}}
        onCancel={onCancel}
      />,
    )

    await send(stdin, 'zzz-no-match')
    expect(lastFrame()).toContain('No sessions match the filter.')

    await send(stdin, ESC)
    await tick(30)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('respects maxHeight with a sliding window over long session lists', async () => {
    const many = Array.from({ length: 12 }, (_, idx) =>
      makeSession({ id: `calm-otter-${idx + 1}`, title: `Session ${idx + 1}` }),
    )
    const { stdin, lastFrame } = render(
      <SessionPicker
        sessions={many}
        maxHeight={6}
        columns={80}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    )

    const initialLines = (lastFrame() ?? '').split('\n')
    expect(initialLines.length).toBeLessThanOrEqual(6)

    for (let i = 0; i < 8; i += 1) await send(stdin, DOWN)
    const scrolled = lastFrame() ?? ''
    expect(scrolled.split('\n').length).toBeLessThanOrEqual(6)
    expect(scrolled).toContain('Session 9')
  })
})

describe('FolderPicker', () => {
  const recentFolders = [
    { id: 'proj-milo', name: 'milo', path: '/home/user/work/milo' },
    { id: 'proj-docs', name: 'docs', path: '/home/user/work/docs' },
  ]

  it('renders clear option and recent folders without borders', () => {
    const { lastFrame } = render(
      <FolderPicker
        currentFolder="/home/user/work/milo"
        recentFolders={recentFolders}
        maxHeight={10}
        columns={90}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''

    expect(frame).toContain('Clear folder (default directory)')
    expect(frame).toContain('milo')
    expect(frame).toContain('/home/user/work/milo · current')
    expect(frame).toContain('docs')
    expect(frame).not.toContain('─')
    expect(frame).not.toMatch(/[╭╰╮╯]/)
  })

  it('selects null for Clear folder and selects a recent folder path when navigated', async () => {
    const onSelect = vi.fn()
    const { stdin } = render(
      <FolderPicker
        currentFolder="/home/user/work/milo"
        recentFolders={recentFolders}
        maxHeight={10}
        columns={90}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    )

    await send(stdin, '\r')
    expect(onSelect).toHaveBeenNthCalledWith(1, null)

    await send(stdin, DOWN)
    await send(stdin, DOWN)
    await send(stdin, '\r')
    expect(onSelect).toHaveBeenNthCalledWith(2, '/home/user/work/docs')
  })

  it('filters recent folders and allows typing a custom path', async () => {
    const onSelect = vi.fn()
    const { stdin, lastFrame } = render(
      <FolderPicker
        currentFolder={null}
        recentFolders={recentFolders}
        maxHeight={10}
        columns={90}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    )

    await send(stdin, 'docs')
    expect(lastFrame()).toContain('/home/user/work/docs')
    expect(lastFrame()).not.toContain('/home/user/work/milo')

    for (let i = 0; i < 4; i += 1) await send(stdin, BACKSPACE)
    await send(stdin, '/tmp/custom-workspace')
    expect(lastFrame()).toContain('Use path: /tmp/custom-workspace')

    await send(stdin, '\r')
    expect(onSelect).toHaveBeenCalledWith('/tmp/custom-workspace')
  })

  it('cancels on Esc and respects maxHeight', async () => {
    const onCancel = vi.fn()
    const manyFolders = Array.from({ length: 10 }, (_, idx) => ({
      id: `p-${idx}`,
      name: `folder-${idx}`,
      path: `/work/folder-${idx}`,
    }))
    const { stdin, lastFrame } = render(
      <FolderPicker
        currentFolder={null}
        recentFolders={manyFolders}
        maxHeight={5}
        columns={80}
        onSelect={() => {}}
        onCancel={onCancel}
      />,
    )

    expect((lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(5)

    await send(stdin, UP) // stays at 0
    await send(stdin, ESC)
    await tick(30)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders header, clear icon, recent marker, and single footer hint cleanly', () => {
    const { lastFrame } = render(
      <FolderPicker
        currentFolder={null}
        recentFolders={recentFolders}
        maxHeight={10}
        columns={90}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Session Folder')
    expect(frame).toContain('Default directory')
    expect(frame).toContain('❯ filter:')
    expect(frame).toContain('▸ ○ Clear folder (default directory)')
    expect(frame).toContain('◆ milo')
    expect(frame).toContain('↑/↓ move · Enter select · Esc close')
  })
})

describe('SessionPicker visual chrome', () => {
  it('shows unread dots, current status in header, active marker, and single footer hint', () => {
    const unreadSession = makeSession({
      id: 'unread-owl-1',
      title: 'Unread updates',
      unread: true,
    })
    const activeSession = makeSession({
      id: 'active-fox-2',
      title: 'Active thread',
      unread: false,
    })
    const { lastFrame } = render(
      <SessionPicker
        sessions={[activeSession, unreadSession]}
        currentSessionId="active-fox-2"
        maxHeight={10}
        columns={90}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('current: active-fox-2')
    expect(frame).toContain('❯ filter:')
    expect(frame).toContain('▸ active-fox-2')
    expect(frame).toContain('● unread-owl-1 — Unread updates')
    expect(frame).toContain('↑/↓ move · Enter open · Esc close')
  })
})

describe('MiloMark', () => {
  it('renders a 3-row shaded half-block mark by default and a 1-line compact mark', () => {
    const hero = render(<MiloMark />).lastFrame() ?? ''
    expect(hero.split('\n')).toHaveLength(3)
    expect(hero).toContain('▄▄█████▄')
    expect(hero).toContain('▄██████▀')
    expect(hero).toContain('▀█████▀')
    expect(hero).not.toContain('─')
    expect(hero).not.toMatch(/[╭╰╮╯]/)

    const compact = render(
      <MiloMark compact theme={{ ...theme, logoTop: '#D96D5A', logoBottom: '#F3B18F' }} />,
    ).lastFrame() ?? ''
    expect(compact.split('\n')).toHaveLength(1)
    expect(compact).toContain('▀▄ MILO')
    expect(compact).not.toContain('─')
    expect(compact).not.toMatch(/[╭╰╮╯]/)
  })
})
