import { describe, expect, test } from 'vitest'
import { shouldGate } from './resolveGate'

describe('shouldGate', () => {
  test('auto mode never gates', () => {
    expect(shouldGate('auto', false)).toBe(false)
    expect(shouldGate('auto', true)).toBe(false)
  })

  test('manual mode gates until the user has checked', () => {
    expect(shouldGate('manual', false)).toBe(true)
    expect(shouldGate('manual', true)).toBe(false)
  })
})
