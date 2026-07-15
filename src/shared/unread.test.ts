import { describe, expect, test } from 'vitest'
import { createUnreadStore, unreadReducer, type UnreadMap } from './unread'
import type { ChangeListener } from './storage'

describe('unreadReducer', () => {
  test('increment creates a topic at 1, then adds', () => {
    let m: UnreadMap = {}
    m = unreadReducer(m, { type: 'increment', topicKey: 'k' })
    expect(m).toEqual({ k: 1 })
    m = unreadReducer(m, { type: 'increment', topicKey: 'k' })
    expect(m).toEqual({ k: 2 })
  })

  test('set overwrites', () => {
    expect(unreadReducer({ k: 5 }, { type: 'set', topicKey: 'k', count: 2 })).toEqual({ k: 2 })
  })

  test('zero sets 0', () => {
    expect(unreadReducer({ k: 5 }, { type: 'zero', topicKey: 'k' })).toEqual({ k: 0 })
  })

  test('zero on an already-0 topic returns the SAME reference (no-op)', () => {
    const m = { k: 0 }
    expect(unreadReducer(m, { type: 'zero', topicKey: 'k' })).toBe(m)
  })

  test('zero on an absent topic returns the SAME reference (no-op)', () => {
    const m = { k: 1 }
    expect(unreadReducer(m, { type: 'zero', topicKey: 'other' })).toBe(m)
  })

  test('set to the same value returns the SAME reference', () => {
    const m = { k: 3 }
    expect(unreadReducer(m, { type: 'set', topicKey: 'k', count: 3 })).toBe(m)
  })

  test('does not mutate the input', () => {
    const m = { k: 1 }
    unreadReducer(m, { type: 'increment', topicKey: 'k' })
    expect(m).toEqual({ k: 1 })
  })
})

describe('createUnreadStore', () => {
  function fakeStorage() {
    const data: Record<string, unknown> = {}
    const listeners = new Set<ChangeListener>()
    return {
      area: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          Object.assign(data, items)
          for (const l of listeners) {
            l(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])), 'session')
          }
        },
      },
      changed: {
        addListener: (l: ChangeListener) => listeners.add(l),
        removeListener: (l: ChangeListener) => listeners.delete(l),
      },
    }
  }

  test('defaults to an empty map and round-trips', async () => {
    const { area, changed } = fakeStorage()
    const store = createUnreadStore(area, changed, 'session')
    expect(await store.load()).toEqual({})
    await store.save({ k: 3 })
    expect(await store.load()).toEqual({ k: 3 })
  })
})
