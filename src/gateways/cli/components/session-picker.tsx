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
      const botName = session.bot?.name ?? ''
      const haystack = [
        session.id,
        session.title ?? '',
        session.label,
        session.preview,
        session.recap ?? '',
        projectName,
        botName,
        session.bot?.handle ?? '',
      ]
        .join(' ')
        .toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
  }, [sessions, filter, projectNames])

  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1))
  const hasFilterGap = maxHeight >= 6
  const listHeight = Math.max(1, maxHeight - (hasFilterGap ? 4 : 3))

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
  const headerStatus = currentSessionId
    ? `current: ${truncateLine(currentSessionId, Math.max(8, innerWidth - headerTitle.length - 12))}`
    : `${sessions.length} total`
  const showHeaderStatus = innerWidth >= headerTitle.length + headerStatus.length + 2
  const filterPlaceholder = truncateLine('Filter by title, id, or folder…', Math.max(1, innerWidth - 11))

  return (
    <Box
      flexDirection="column"
      backgroundColor={activeTheme.surface}
      paddingX={2}
      width={columns}
    >
      <Box justifyContent="space-between" width={innerWidth}>
        <Text bold>{headerTitle}</Text>
        {showHeaderStatus ? <Text color={activeTheme.surfaceText}>{headerStatus}</Text> : null}
      </Box>

      <Box width={innerWidth} marginBottom={hasFilterGap ? 1 : 0}>
        <Text bold color={activeTheme.surfaceText}>
          ❯ filter:{' '}
        </Text>
        <Text>{filter}</Text>
        <Text inverse> </Text>
        {filter === '' && <Text color={activeTheme.surfaceText}>{filterPlaceholder}</Text>}
      </Box>

      {filtered.length === 0 ? (
        <Box width={innerWidth}>
          <Text color={activeTheme.surfaceText}>
            {sessions.length === 0 ? 'No saved sessions yet.' : 'No sessions match the filter.'}
          </Text>
        </Box>
      ) : (
        visible.map((session, offset) => {
          const absolute = windowStart + offset
          const isSelected = absolute === safeSelected
          const isCurrent = Boolean(currentSessionId && session.id === currentSessionId)
          const label = sessionLabel(session) || (session.bot ? `Chat with ${session.bot.name}` : '')
          const projectName = session.project ? projectNames?.[session.project] : undefined
          const botTag = session.bot ? `bot:${session.bot.name}` : undefined
          const when = formatWhen(session.updatedAt)
          const baseMetaParts = [
            botTag,
            projectName,
            `${session.messageCount} ${session.messageCount === 1 ? 'msg' : 'msgs'}`,
            when,
          ].filter(Boolean)
          const baseMeta = baseMetaParts.join(' · ')
          const currentTag = isCurrent ? 'current' : ''
          const fullMeta = [baseMeta, currentTag].filter(Boolean).join(' · ')

          const prefix = isSelected ? '▸ ' : '  '
          const mark = session.unread ? '● ' : ''
          const idLead = label ? `${session.id} — ` : session.id
          const titleBudget = Math.max(
            8,
            innerWidth - prefix.length - mark.length - idLead.length - fullMeta.length - 2,
          )
          const titleText = label ? truncateLine(label, titleBudget) : ''
          const primaryLead = truncateLine(
            `${prefix}${mark}${idLead}${titleText}`,
            Math.max(8, innerWidth - fullMeta.length - 2),
          )
          const spacer = '  '
          const metaBudget = Math.max(0, innerWidth - primaryLead.length - spacer.length)
          const clippedMeta = truncateLine(fullMeta, metaBudget)
          const rowLen = primaryLead.length + (clippedMeta ? spacer.length + clippedMeta.length : 0)
          const pad = isSelected ? ' '.repeat(Math.max(0, innerWidth - rowLen)) : ''

          if (isSelected) {
            return (
              <Box key={session.id} width={innerWidth}>
                <Text inverse bold wrap="truncate">
                  {primaryLead}
                  {clippedMeta ? `${spacer}${clippedMeta}` : ''}
                  {pad}
                </Text>
              </Box>
            )
          }

          const leadWithoutMark = primaryLead.slice(prefix.length + mark.length)
          const baseMetaShown = truncateLine(baseMeta, metaBudget)
          const remainingAfterBase = Math.max(0, metaBudget - baseMetaShown.length)
          const showCurrentTag =
            isCurrent && remainingAfterBase >= (baseMetaShown ? 3 + currentTag.length : currentTag.length)

          return (
            <Box key={session.id} width={innerWidth}>
              <Text wrap="truncate">
                <Text>{prefix}</Text>
                {mark ? <Text bold color={activeTheme.surfaceText}>{mark}</Text> : null}
                <Text>{leadWithoutMark}</Text>
                {clippedMeta ? (
                  <>
                    <Text color={activeTheme.surfaceText}>{spacer}</Text>
                    {baseMetaShown ? (
                      <Text color={activeTheme.surfaceText}>{baseMetaShown}</Text>
                    ) : null}
                    {showCurrentTag ? (
                      <>
                        {baseMetaShown ? <Text color={activeTheme.surfaceText}> · </Text> : null}
                        <Text bold>{currentTag}</Text>
                      </>
                    ) : null}
                  </>
                ) : null}
              </Text>
            </Box>
          )
        })
      )}

      <Box width={innerWidth}>
        <Text color={activeTheme.surfaceText}>↑/↓ move · Enter open · Esc close</Text>
      </Box>
    </Box>
  )
}
