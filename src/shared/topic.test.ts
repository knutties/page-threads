import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { matchTopicByKey, topicKey, topicName } from './topic'

describe('topicKey', () => {
  test('matches independent sha256/base64url computation', async () => {
    const uri = 'web:https://example.com/'
    const expected = createHash('sha256').update(uri).digest('base64url').slice(0, 16)
    expect(await topicKey(uri)).toBe(expected)
  })

  test('is 16 chars of base64url alphabet', async () => {
    const key = await topicKey('web:https://example.com/a?b=1')
    expect(key).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  test('different URIs give different keys', async () => {
    expect(await topicKey('web:https://a.com/')).not.toBe(await topicKey('web:https://b.com/'))
  })
})

describe('topicName', () => {
  test('joins title and key with " · "', () => {
    expect(topicName('My Page', 'k'.repeat(16))).toBe(`My Page · ${'k'.repeat(16)}`)
  })

  test('truncates title to 40 chars (total stays under Zulip 60-char limit)', () => {
    const name = topicName('x'.repeat(100), 'k'.repeat(16))
    expect(name).toBe(`${'x'.repeat(40)} · ${'k'.repeat(16)}`)
    expect(name.length).toBeLessThanOrEqual(60)
  })

  test('falls back to Untitled for empty title', () => {
    expect(topicName('   ', 'k'.repeat(16))).toBe(`Untitled · ${'k'.repeat(16)}`)
  })

  test('truncation never splits a surrogate pair', () => {
    const title = 'a'.repeat(39) + '😀' + 'b'.repeat(10)
    const name = topicName(title, 'k'.repeat(16))
    expect(name).toBe(`${'a'.repeat(39)} · ${'k'.repeat(16)}`)
    expect(name.includes('\uD83D')).toBe(false)
  })
})

describe('matchTopicByKey', () => {
  test('finds topic by suffix regardless of title part', () => {
    const topics = ['Other thing · aaaaaaaaaaaaaaaa', 'Renamed Title · bbbbbbbbbbbbbbbb']
    expect(matchTopicByKey(topics, 'bbbbbbbbbbbbbbbb')).toBe('Renamed Title · bbbbbbbbbbbbbbbb')
  })

  test('returns null when absent', () => {
    expect(matchTopicByKey(['A · aaaaaaaaaaaaaaaa'], 'cccccccccccccccc')).toBeNull()
  })
})
