import { basename } from 'node:path'
import { useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { theme, type TuiTheme } from '../theme.js'
import { truncateLine } from './composer.js'
import { usePickerInput } from './picker-input.js'

export interface RecentFolder {
  id: string
  name?: string
  path: string
}

export interface FolderPickerProps {
  currentFolder: string | null
  recentFolders: RecentFolder[]
  maxHeight: number
  columns: number
  theme?: TuiTheme
  onSelect: (folder: string | null) => void
  onCancel: () => void
}

type FolderOption =
  | { key: string; kind: 'clear'; label: string; detail?: string; value: null }
  | { key: string; kind: 'recent'; label: string; detail: string; value: string; current: boolean }
  | { key: string; kind: 'custom'; label: string; detail: string; value: string }

function looksLikePath(text: string): boolean {
  return /^([/~.]|[a-zA-Z]:[\\/])/.test(text) || text.includes('/')
}

export function FolderPicker({
  currentFolder,
  recentFolders,
  maxHeight,
  columns,
  theme: activeTheme = theme,
  onSelect,
  onCancel,
}: FolderPickerProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)

  const options = useMemo<FolderOption[]>(() => {
    const trimmed = query.trim()
    const lower = trimmed.toLowerCase()
    const items: FolderOption[] = []

    const clearMatches =
      lower === '' || 'clear folder default directory none'.includes(lower)
    const clearOption: FolderOption = {
      key: '__clear__',
      kind: 'clear',
      label: 'Clear folder (default directory)',
      detail: currentFolder === null ? 'current' : undefined,
      value: null,
    }

    const matchedRecent: FolderOption[] = recentFolders
      .filter((folder) => {
        if (!lower) return true
        const displayName = folder.name ?? basename(folder.path)
        return `${displayName} ${folder.id} ${folder.path}`.toLowerCase().includes(lower)
      })
      .map((folder) => {
        const displayName = folder.name || basename(folder.path) || folder.path
        const isCurrent = currentFolder === folder.path || currentFolder === folder.id
        return {
          key: `recent:${folder.id}:${folder.path}`,
          kind: 'recent',
          label: displayName,
          detail: isCurrent ? `${folder.path} · current` : folder.path,
          value: folder.path,
          current: isCurrent,
        }
      })

    const hasExactRecent = matchedRecent.some((opt) => opt.value === trimmed)
    const customOption: FolderOption | null =
      trimmed !== '' && !hasExactRecent
        ? {
            key: `custom:${trimmed}`,
            kind: 'custom',
            label: `Use path: ${trimmed}`,
            detail: 'custom folder',
            value: trimmed,
          }
        : null

    if (customOption && looksLikePath(trimmed)) {
      items.push(customOption)
      if (clearMatches) items.push(clearOption)
      items.push(...matchedRecent)
    } else {
      if (clearMatches) items.push(clearOption)
      items.push(...matchedRecent)
      if (customOption) items.push(customOption)
    }

    return items
  }, [query, recentFolders, currentFolder])

  const safeSelected = Math.min(selected, Math.max(0, options.length - 1))
  const hasFilterGap = maxHeight >= 6
  const listHeight = Math.max(1, maxHeight - (hasFilterGap ? 4 : 3))

  usePickerInput({
    count: options.length,
    listHeight,
    setQuery,
    setSelected,
    onSelect: () => {
      const picked = options[safeSelected]
      if (picked) {
        onSelect(picked.value)
      } else if (query.trim()) {
        onSelect(query.trim())
      }
    },
    onCancel,
  })

  const innerWidth = Math.max(16, columns - 4)
  const windowStart = Math.max(
    0,
    Math.min(safeSelected - Math.floor(listHeight / 2), options.length - listHeight),
  )
  const visible = options.slice(windowStart, windowStart + listHeight)

  const headerTitle = 'Session Folder'
  const headerStatus = currentFolder
    ? truncateLine(currentFolder, Math.max(10, innerWidth - headerTitle.length - 4))
    : 'Default directory'
  const showHeaderStatus = innerWidth >= headerTitle.length + headerStatus.length + 2
  const filterPlaceholder = truncateLine('Filter recent folders or type a path…', Math.max(1, innerWidth - 11))

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
        <Text>{query}</Text>
        <Text inverse> </Text>
        {query === '' && <Text color={activeTheme.surfaceText}>{filterPlaceholder}</Text>}
      </Box>

      {visible.map((option, offset) => {
        const absolute = windowStart + offset
        const isSelected = absolute === safeSelected
        const prefix = isSelected ? '▸ ' : '  '
        const icon = option.kind === 'clear' ? '○ ' : option.kind === 'custom' ? '+ ' : '◆ '
        const label = truncateLine(`${prefix}${icon}${option.label}`, innerWidth)
        const detailRoom = Math.max(0, innerWidth - label.length - 2)
        const detail = option.detail && detailRoom > 3 ? `  ${truncateLine(option.detail, detailRoom)}` : ''
        const pad = isSelected ? ' '.repeat(Math.max(0, innerWidth - label.length - detail.length)) : ''

        if (isSelected) {
          return (
            <Box key={option.key} width={innerWidth}>
              <Text inverse bold wrap="truncate">
                {label}
                {detail}
                {pad}
              </Text>
            </Box>
          )
        }

        const labelText = label.slice(prefix.length + icon.length)
        return (
          <Box key={option.key} width={innerWidth}>
            <Text wrap="truncate">
              <Text>{prefix}</Text>
              <Text color={activeTheme.surfaceText}>{icon}</Text>
              <Text bold={option.kind === 'recent'}>{labelText}</Text>
              {detail ? <Text color={activeTheme.surfaceText}>{detail}</Text> : null}
            </Text>
          </Box>
        )
      })}

      <Box width={innerWidth}>
        <Text color={activeTheme.surfaceText}>↑/↓ move · Enter select · Esc close</Text>
      </Box>
    </Box>
  )
}
