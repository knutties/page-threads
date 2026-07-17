import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { startsNewGroup } from './messageGroup'

function m(over: Partial<ZulipMessage>): ZulipMessage {
  return {
    id: 1, sender_full_name: 'Ada', sender_email: 'ada@x.com',
    content: '<p>x</p>', timestamp: 1000, subject: 'T · k', ...over,
  }
}

describe('startsNewGroup', () => {
  test('the first message always starts a group', () => {
    expect(startsNewGroup(null, m({}))).toBe(true)
  })
  test('a different sender starts a group', () => {
    expect(startsNewGroup(m({ sender_email: 'ada@x.com' }), m({ sender_email: 'bo@x.com' }))).toBe(true)
  })
  test('same sender within 5 minutes groups', () => {
    expect(startsNewGroup(m({ timestamp: 1000 }), m({ timestamp: 1000 + 200 }))).toBe(false)
  })
  test('same sender after more than 5 minutes starts a group', () => {
    expect(startsNewGroup(m({ timestamp: 1000 }), m({ timestamp: 1000 + 301 }))).toBe(true)
  })
})
