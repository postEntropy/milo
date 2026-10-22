import test from 'node:test'
import assert from 'node:assert/strict'
import { PADDING, barFrame } from '../src/bar.mjs'

const LONG = 'a project name long enough to fill the whole bar'

test('a long name leaves room for the controls', () => {
  const frame = barFrame({ label: LONG, screenWidth: 390, controlsWidth: 180 })
  assert.ok(
    frame.labelWidth + frame.controlsWidth + PADDING <= frame.screenWidth,
    `${frame.labelWidth} + ${frame.controlsWidth} + ${PADDING} > ${frame.screenWidth}`,
  )
})

test('a short name is not truncated', () => {
  const frame = barFrame({ label: 'milo', screenWidth: 430, controlsWidth: 180 })
  assert.equal(frame.labelWidth, 28)
})
