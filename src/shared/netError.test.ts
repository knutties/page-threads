import { describe, expect, test } from 'vitest'
import { isNetworkError } from './netError'
import { ZulipError } from './zulipClient'

describe('isNetworkError', () => {
  test('a fetch TypeError is a network error', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true)
  })
  test('a ZulipError (HTTP status) is not a network error', () => {
    expect(isNetworkError(new ZulipError('HTTP 429', 'RATE_LIMIT'))).toBe(false)
  })
  test('a plain Error is not a network error', () => {
    expect(isNetworkError(new Error('boom'))).toBe(false)
  })
})
