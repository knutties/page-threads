import { describe, expect, test } from 'vitest'
import { shouldStickToBottom } from './scroll'

describe('shouldStickToBottom', () => {
  test('at the exact bottom → true', () => {
    expect(shouldStickToBottom(900, 1500, 600)).toBe(true)
  })

  test('within the 100px threshold → true', () => {
    expect(shouldStickToBottom(801, 1500, 600)).toBe(true)
  })

  test('beyond the threshold (reading scrollback) → false', () => {
    expect(shouldStickToBottom(799, 1500, 600)).toBe(false)
  })

  test('content shorter than the viewport → true', () => {
    expect(shouldStickToBottom(0, 400, 600)).toBe(true)
  })

  test('custom threshold is honored', () => {
    expect(shouldStickToBottom(700, 1500, 600, 200)).toBe(true)
    expect(shouldStickToBottom(699, 1500, 600, 200)).toBe(false)
  })
})
