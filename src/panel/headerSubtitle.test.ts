import { describe, expect, test } from 'vitest'
import { headerSubtitle } from './headerSubtitle'

describe('headerSubtitle', () => {
  test('shows host and pluralized message count', () => {
    expect(headerSubtitle('web:https://www.rediff.com/cricket/x.htm', 5)).toBe('www.rediff.com · 5 messages')
    expect(headerSubtitle('web:https://example.com/a', 1)).toBe('example.com · 1 message')
  })
  test('falls back to just the count when the URI has no parseable host', () => {
    expect(headerSubtitle('web:not a url', 3)).toBe('3 messages')
  })
})
