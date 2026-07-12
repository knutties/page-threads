import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from '../shared/zulipClient'
import { threadReducer } from './threadState'

function msg(id: number): ZulipMessage {
  return { id, sender_full_name: 'A', sender_email: 'a@x', content: `m${id}`, timestamp: id, subject: 't' }
}

describe('threadReducer', () => {
  test('history replaces state sorted by id', () => {
    const out = threadReducer([msg(9)], { type: 'history', messages: [msg(3), msg(1), msg(2)] })
    expect(out.map((m) => m.id)).toEqual([1, 2, 3])
  })

  test('append adds in id order', () => {
    const out = threadReducer([msg(1), msg(3)], { type: 'append', message: msg(2) })
    expect(out.map((m) => m.id)).toEqual([1, 2, 3])
  })

  test('append dedupes by id (own message arrives via refetch AND event)', () => {
    const state = [msg(1), msg(2)]
    expect(threadReducer(state, { type: 'append', message: msg(2) })).toBe(state)
  })
})
