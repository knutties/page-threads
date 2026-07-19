import { describe, expect, test } from 'vitest'
import { resolveBrowser } from './browser'

describe('resolveBrowser', () => {
  test('prefers a native browser.* namespace when present', () => {
    const b = {} as typeof chrome
    const c = {} as typeof chrome
    expect(resolveBrowser({ browser: b, chrome: c })).toBe(b)
  })

  test('falls back to chrome when browser is absent', () => {
    const c = {} as typeof chrome
    expect(resolveBrowser({ chrome: c })).toBe(c)
  })

  test('uses browser even when chrome is also present-but-undefined', () => {
    const b = {} as typeof chrome
    expect(resolveBrowser({ browser: b })).toBe(b)
  })
})
