import { describe, expect, test } from 'vitest'
import { resolveEffectiveTheme } from './theme'

describe('resolveEffectiveTheme', () => {
  test('system follows the OS preference', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark')
    expect(resolveEffectiveTheme('system', false)).toBe('light')
  })

  test('explicit light/dark ignore the OS preference', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light')
    expect(resolveEffectiveTheme('light', false)).toBe('light')
    expect(resolveEffectiveTheme('dark', true)).toBe('dark')
    expect(resolveEffectiveTheme('dark', false)).toBe('dark')
  })
})
