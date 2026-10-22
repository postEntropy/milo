export const PADDING = 12

/** How wide the text is, at the bar's type size. */
export function textWidth(text) {
  return text.length * 7
}

/** The frame of the top bar: the project's name, and the controls beside it. */
export function barFrame({ label, screenWidth, controlsWidth }) {
  // The name keeps a fixed share of the screen, whatever sits beside it.
  const room = Math.min(screenWidth * 0.6, 320)
  const labelWidth = Math.min(textWidth(label), room)
  return { labelWidth, controlsWidth, screenWidth }
}
