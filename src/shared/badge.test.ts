import { describe, expect, test } from 'vitest'
import { badgeText, keyFromTopicName } from './badge'

describe('badgeText', () => {
  test('positive unread shows the number', () => {
    expect(badgeText(1, true)).toBe('1')
    expect(badgeText(42, true)).toBe('42')
  })

  test('caps at 99+', () => {
    expect(badgeText(99, true)).toBe('99')
    expect(badgeText(100, true)).toBe('99+')
    expect(badgeText(5000, true)).toBe('99+')
  })

  test('a thread with zero unread shows a dot', () => {
    expect(badgeText(0, true)).toBe('•')
  })

  test('no thread shows nothing (even if a stale count is passed)', () => {
    expect(badgeText(0, false)).toBe('')
    expect(badgeText(3, false)).toBe('')
  })
})

describe('keyFromTopicName', () => {
  test('extracts the 16-char key after the middle dot', () => {
    expect(keyFromTopicName(`My Page · ${'k'.repeat(16)}`)).toBe('k'.repeat(16))
  })

  test('extracts even when the title contains a middle dot', () => {
    expect(keyFromTopicName(`A · B · ${'x'.repeat(16)}`)).toBe('x'.repeat(16))
  })

  test('returns null when there is no key suffix', () => {
    expect(keyFromTopicName('no key here')).toBeNull()
    expect(keyFromTopicName('Title · short')).toBeNull()
  })
})
