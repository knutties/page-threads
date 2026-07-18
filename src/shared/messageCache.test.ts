import { describe, expect, test } from 'vitest'
import type { ZulipMessage } from './zulipClient'
import { cacheReducer, createMessageCache, CACHE_CAP, type MessageCacheMap } from './messageCache'

function msg(id: number): ZulipMessage {
  return { id, sender_full_name: 'A', sender_email: 'a@x.com', content: `<p>${id}</p>`, timestamp: id, subject: 'T · k' }
}

describe('cacheReducer', () => {
  test('put creates an entry stamped with now', () => {
    const next = cacheReducer({}, { type: 'put', topicKey: 'k1', messages: [msg(1)], now: 100, cap: 50 })
    expect(next.k1).toEqual({ messages: [msg(1)], at: 100 })
  })

  test('put over cap evicts the least-recently-used entries', () => {
    let map: MessageCacheMap = {}
    for (let i = 0; i < 3; i++) map = cacheReducer(map, { type: 'put', topicKey: `k${i}`, messages: [msg(i)], now: i, cap: 2 })
    // k0 (at:0) is the oldest → evicted; k1,k2 survive
    expect(Object.keys(map).sort()).toEqual(['k1', 'k2'])
  })

  test('touch bumps at; absent key returns the same reference', () => {
    const map: MessageCacheMap = { k1: { messages: [msg(1)], at: 1 } }
    const bumped = cacheReducer(map, { type: 'touch', topicKey: 'k1', now: 9 })
    expect(bumped.k1.at).toBe(9)
    expect(cacheReducer(map, { type: 'touch', topicKey: 'nope', now: 9 })).toBe(map)
  })
})

function fakeArea(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial }
  return {
    store,
    get: async (key: string) => (key in store ? { [key]: store[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(store, items)
    },
  }
}

describe('createMessageCache', () => {
  test('save then load round-trips the messages', async () => {
    const area = fakeArea()
    const cache = createMessageCache(area)
    await cache.save('k1', [msg(1), msg(2)])
    expect(await cache.load('k1')).toEqual([msg(1), msg(2)])
    expect(await cache.load('missing')).toBeNull()
  })

  test('saving past the cap evicts the least-recently-used topic', async () => {
    let t = 0
    const area = fakeArea()
    const cache = createMessageCache(area, () => t++)
    for (let i = 0; i <= CACHE_CAP; i++) await cache.save(`k${i}`, [msg(i)]) // CACHE_CAP+1 topics
    expect(await cache.load('k0')).toBeNull() // oldest evicted
    expect(await cache.load(`k${CACHE_CAP}`)).toEqual([msg(CACHE_CAP)]) // newest survives
  })

  test('a QUOTA_BYTES write error triggers aggressive eviction and a retry', async () => {
    const area = fakeArea()
    let failed = false
    const realSet = area.set
    area.set = async (items: Record<string, unknown>) => {
      if (!failed) {
        failed = true
        throw new Error('QUOTA_BYTES quota exceeded')
      }
      return realSet(items)
    }
    const cache = createMessageCache(area)
    await cache.save('k1', [msg(1)]) // first set throws, retry succeeds
    expect(failed).toBe(true)
    expect(await cache.load('k1')).toEqual([msg(1)])
  })
})
