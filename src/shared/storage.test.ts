import { describe, expect, test } from 'vitest'
import { createStore, type ChangeListener } from './storage'

function fakeStorage(initial: Record<string, unknown> = {}, getDelayMs = 0) {
  const data: Record<string, unknown> = { ...initial }
  const listeners = new Set<ChangeListener>()
  const area = {
    get: async (key: string) => {
      if (getDelayMs) await new Promise((r) => setTimeout(r, getDelayMs))
      return key in data ? { [key]: data[key] } : {}
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
      for (const l of listeners) {
        l(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])), 'local')
      }
    },
  }
  const changed = {
    addListener: (l: ChangeListener) => listeners.add(l),
    removeListener: (l: ChangeListener) => listeners.delete(l),
  }
  return { area, changed, data }
}

describe('createStore', () => {
  test('load merges stored partial over defaults', async () => {
    const { area, changed } = fakeStorage({ t: { a: 5 } })
    const store = createStore('t', { a: 0, b: 'x' }, area, changed)
    expect(await store.load()).toEqual({ a: 5, b: 'x' })
  })

  test('CONCURRENT saves of different fields both land (M1a race)', async () => {
    const { area, changed, data } = fakeStorage({}, 5)
    const store = createStore('t', { a: 0, b: 0 }, area, changed)
    await Promise.all([store.save({ a: 1 }), store.save({ b: 2 })])
    expect(data.t).toEqual({ a: 1, b: 2 })
  })

  test('a failed save does not wedge the queue', async () => {
    const { area, changed, data } = fakeStorage()
    let failNext = true
    const flakyArea = {
      get: area.get,
      set: async (items: Record<string, unknown>) => {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        return area.set(items)
      },
    }
    const store = createStore('t', { a: 0 }, flakyArea, changed)
    await expect(store.save({ a: 1 })).rejects.toThrow('disk full')
    await store.save({ a: 2 })
    expect(data.t).toEqual({ a: 2 })
  })

  test('watch fires with merged value on matching area; unsubscribe stops it', async () => {
    const { area, changed } = fakeStorage()
    const store = createStore('t', { a: 0, b: 'x' }, area, changed, 'local')
    const seen: unknown[] = []
    const unsub = store.watch((v) => seen.push(v))
    await area.set({ t: { a: 3 } })
    expect(seen).toEqual([{ a: 3, b: 'x' }])
    unsub()
    await area.set({ t: { a: 4 } })
    expect(seen).toHaveLength(1)
  })

  test('watch ignores other keys and other areas', async () => {
    const { area, changed } = fakeStorage()
    const store = createStore('t', { a: 0 }, area, changed, 'sync')
    const seen: unknown[] = []
    store.watch((v) => seen.push(v))
    await area.set({ t: { a: 1 } }) // fires as 'local', store watches 'sync'
    await area.set({ other: 1 })
    expect(seen).toEqual([])
  })
})
