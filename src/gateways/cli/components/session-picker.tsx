import { useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { sessionLabel } from '../../../core/sessions/format.js'
import type { SessionSummary } from '../../../core/sessions/types.js'
import { formatWhen } from '../../../core/time.js'
import { theme, type TuiTheme } from '../theme.js'
import { truncateLine } from './composer.js'
import { usePickerInput } from './picker-input.js'

export interface SessionPickerProps {
  sessions: SessionSummary[]
  projectNames?: Record<string, string>
  currentSessionId?: string | null
  maxHeight: number
  columns: number
  theme?: TuiTheme
  onSelect: (id: string) => void
  onCancel: () => void
}

export function SessionPicker({
  sessions,
  projectNames,
  currentSessionId,
  maxHeight,
  columns,
  theme: activeTheme = theme,
  onSelect,
  onCancel,
}: SessionPickerProps) {
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState(0)

  const filtered = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return sessions
    return sessions.filter((session) => {
      const projectName = session.project ? (projectNames?.[session.project] ?? '') : ''
      const haystack = [
        session.id,
        session.title ?? '',
        session.label,
        session.preview,
        session.recap ?? '',
        projectName,
      ]
        .join(' ')
        .toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [sessions, filter, projectNames])

  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1))
  const listHeight = Math.max(1, maxHeight - 2)

  usePickerInput({
    count: filtered.length,
    listHeight,
    setQuery: setFilter,
    setSelected,
    onSelect: () => {
      const picked = filtered[safeSelected]
      if (picked) onSelect(picked.id)
    },
    onCancel,
  })

  const innerWidth = Math.max(16, columns - 4)
  const windowStart = Math.max(
    0,
    Math.min(safeSelected - Math.floor(listHeight / 2), filtered.length - listHeight),
  )
  const visible = filtered.slice(windowStart, windowStart + listHeight)

  const headerTitle =
    filter.trim() === ''
      ? `Sessions (${sessions.length})`
      : `Sessions (${filtered.length}/${sessions.length})`

  return (
    <Box
      flexDirection="column"
      backgroundColor={activeTheme.surface}
      paddingX={2}
      width={columns}
    >
      <Box justifyContent="space-between" width={innerWidth}>
        <Text bold>{headerTitle}</Text>
        <Text color={activeTheme.surfaceText}>↑/↓ move · Enter select · Esc cancel</Text>
      </Box>

      <Box width={innerWidth}>
        <Text color={activeTheme.surfaceText}>filter: </Text>
        <Text>{filter}</Text>
        <Text inverse> </Text>
        {filter === '' && (
          <Text color={activeTheme.surfaceText}>Type to filter by title, id, or folder…</Text>
        )}
      </Box>

      {filtered.length === 0 ? (
        <Text color={activeTheme.surfaceText}>
          {sessions.length === 0 ? 'No saved sessions yet.' : 'No sessions match the filter.'}
        </Text>
      ) : (
        visible.map((session, offset) => {
          const absolute = windowStart + offset
          const isSelected = absolute === safeSelected
          const isCurrent = Boolean(currentSessionId && session.id === currentSessionId)
          const label = sessionLabel(session)
          const projectName = session.project ? projectNames?.[session.project] : undefined
          const when = formatWhen(session.updatedAt)
          const metaParts = [
            projectName,
            `${session.messageCount} ${session.messageCount === 1 ? 'msg' : 'msgs'}`,
            when,
            isCurrent ? 'current' : '',
          ].filter(Boolean)
          const meta = metaParts.join(' · ')
          const prefix = isSelected ? '❯ ' : '  '
          const mark = session.unread ? '● ' : ''
          const idLead = label ? `${session.id} — ` : session.id
          const titleBudget = Math.max(8, innerWidth - prefix.length - mark.length - idLead.length - meta.length - 2)
          const titleText = label ? truncateLine(label, titleBudget) : ''
          const primary = truncateLine(`${prefix}${mark}${idLead}${titleText}`, innerWidth - meta.length - 2)
          const spacer = '  '

          return (
            <Box key={session.id} width={innerWidth}>
              <Text bold={isSelected} wrap="truncate">
                <Text bold={isSelected}>{primary}</Text>
                <Text color={activeTheme.surfaceText}>
                  {spacer}
                  {truncateLine(meta, Math.max(0, innerWidth - primary.length - spacer.length))}
                </Text>
              </Text>
            </Box>
          )
        })
      )}
    </Box>
  )
}
