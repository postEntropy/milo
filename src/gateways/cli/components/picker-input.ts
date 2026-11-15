import type { Dispatch, SetStateAction } from 'react'
import { useInput } from 'ink'
import { isCtrlC } from '../keys.js'

interface UsePickerInputOptions {
  count: number
  listHeight: number
  setQuery: Dispatch<SetStateAction<string>>
  setSelected: Dispatch<SetStateAction<number>>
  onSelect: () => void
  onCancel: () => void
}

/** Shared keyboard navigation and filter editing for overlay list pickers. */
export function usePickerInput({
  count,
  listHeight,
  setQuery,
  setSelected,
  onSelect,
  onCancel,
}: UsePickerInputOptions): void {
  const maxIndex = Math.max(0, count - 1)
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (isCtrlC(input, key) || key.escape) {
      onCancel()
      return
    }
    if (key.return) {
      onSelect()
      return
    }
    if (key.upArrow) {
      setSelected((value) => Math.max(0, value - 1))
      return
    }
    if (key.downArrow) {
      setSelected((value) => Math.min(maxIndex, value + 1))
      return
    }
    if (key.pageUp) {
      setSelected((value) => Math.max(0, value - listHeight))
      return
    }
    if (key.pageDown) {
      setSelected((value) => Math.min(maxIndex, value + listHeight))
      return
    }
    if (key.ctrl && input.toLowerCase() === 'u') {
      setQuery('')
      setSelected(0)
      return
    }
    if (key.ctrl && input.toLowerCase() === 'w') {
      setQuery((value) => value.replace(/\S+\s*$/, ''))
      setSelected(0)
      return
    }
    if (key.backspace || key.delete) {
      setQuery((value) => value.slice(0, -1))
      setSelected(0)
      return
    }
    if (key.ctrl || key.meta || key.tab) return
    if (!input) return
    const printable = [...input].filter((ch) => (ch.codePointAt(0) ?? 0) >= 0x20).join('')
    if (!printable) return
    setQuery((value) => value + printable)
    setSelected(0)
  })
}
