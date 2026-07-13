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

  test('update replaces content by id; unknown id is a no-op', () => {
    const state = [msg(1), msg(2)]
    const out = threadReducer(state, { type: 'update', id: 2, content: '<p>edited</p>' })
    expect(out.find((m) => m.id === 2)!.content).toBe('<p>edited</p>')
    expect(out.find((m) => m.id === 1)!.content).toBe('m1')
    expect(threadReducer(state, { type: 'update', id: 99, content: 'x' })).toBe(state)
  })

  test('remove deletes by id; unknown id is a no-op', () => {
    const state = [msg(1), msg(2)]
    expect(threadReducer(state, { type: 'remove', id: 1 }).map((m) => m.id)).toEqual([2])
    expect(threadReducer(state, { type: 'remove', id: 99 })).toBe(state)
  })

  test('reaction add appends once (idempotent) and remove deletes the matching entry', () => {
    const r = { emoji_name: '+1', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 7 }
    const state = [msg(1)]
    const added = threadReducer(state, { type: 'reaction', op: 'add', id: 1, reaction: r })
    expect(added[0].reactions).toEqual([r])
    const addedTwice = threadReducer(added, { type: 'reaction', op: 'add', id: 1, reaction: r })
    expect(addedTwice[0].reactions).toEqual([r])
    const otherUser = threadReducer(added, { type: 'reaction', op: 'add', id: 1, reaction: { ...r, user_id: 8 } })
    expect(otherUser[0].reactions).toHaveLength(2)
    const removed = threadReducer(otherUser, { type: 'reaction', op: 'remove', id: 1, reaction: r })
    expect(removed[0].reactions).toEqual([{ ...r, user_id: 8 }])
    expect(threadReducer(state, { type: 'reaction', op: 'remove', id: 1, reaction: r })[0].reactions ?? []).toEqual([])
  })

  test('reaction for an unknown message id returns the same state reference', () => {
    const r = { emoji_name: '+1', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 7 }
    const state = [msg(1)]
    expect(threadReducer(state, { type: 'reaction', op: 'add', id: 99, reaction: r })).toBe(state)
  })
})
