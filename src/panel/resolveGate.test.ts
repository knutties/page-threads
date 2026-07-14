import { describe, expect, test } from 'vitest'
import { shouldGate } from './resolveGate'

describe('shouldGate', () => {
  test('manual mode gates, auto does not', () => {
    expect(shouldGate('manual')).toBe(true)
    expect(shouldGate('auto')).toBe(false)
  })
})
