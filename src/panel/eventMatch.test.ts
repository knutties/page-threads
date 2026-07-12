import { describe, expect, test } from 'vitest'
import { topicMatchesKey } from './eventMatch'

describe('topicMatchesKey', () => {
  test('matches a topic created by this extension', () => {
    expect(topicMatchesKey(`My Page · ${'k'.repeat(16)}`, 'k'.repeat(16))).toBe(true)
  })

  test('still matches after the title part is renamed in Zulip', () => {
    expect(topicMatchesKey(`Renamed by a moderator · ${'k'.repeat(16)}`, 'k'.repeat(16))).toBe(true)
  })

  test('rejects a different key', () => {
    expect(topicMatchesKey(`My Page · ${'a'.repeat(16)}`, 'k'.repeat(16))).toBe(false)
  })
})
