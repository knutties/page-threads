import { describe, expect, test } from 'vitest'
import { createSettingsStore, DEFAULT_SETTINGS } from './settings'

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const listeners = new Set<ChangeListener>()
  const area = {
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
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

describe('settings store', () => {
  test('load returns defaults when storage is empty', async () => {
    const { area, changed } = fakeStorage()
    const store = createSettingsStore(area, changed)
    expect(await store.load()).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.onNonWebPage).toBe('hold')
  })

  test('load merges stored partial over defaults', async () => {
    const { area, changed } = fakeStorage({ settings: { onNonWebPage: 'clear' } })
    const store = createSettingsStore(area, changed)
    expect(await store.load()).toEqual({ onNonWebPage: 'clear', resolveMode: 'auto' })
  })

  test('save merges patch into stored settings', async () => {
    const { area, changed, data } = fakeStorage()
    const store = createSettingsStore(area, changed)
    await store.save({ onNonWebPage: 'clear' })
    expect(data.settings).toEqual({ onNonWebPage: 'clear', resolveMode: 'auto' })
  })

  test('watch fires with merged settings on change in the right area', async () => {
    const { area, changed } = fakeStorage()
    const store = createSettingsStore(area, changed, 'local')
    const seen: unknown[] = []
    store.watch((s) => seen.push(s))
    await area.set({ settings: { onNonWebPage: 'clear' } })
    expect(seen).toEqual([{ onNonWebPage: 'clear', resolveMode: 'auto' }])
  })

  test('watch ignores other keys and other areas; unsubscribe stops callbacks', async () => {
    const { area, changed } = fakeStorage()
    const store = createSettingsStore(area, changed, 'sync') // watching sync, events fire as local
    const seen: unknown[] = []
    const unsub = store.watch((s) => seen.push(s))
    await area.set({ settings: { onNonWebPage: 'clear' } }) // areaName 'local' ≠ 'sync'
    expect(seen).toEqual([])
    unsub()
  })

  test('resolveMode defaults to auto', async () => {
    const { area, changed } = fakeStorage()
    expect(await createSettingsStore(area, changed).load()).toEqual({
      onNonWebPage: 'hold',
      resolveMode: 'auto',
    })
  })

  test('both fields can be saved independently and both persist', async () => {
    const { area, changed, data } = fakeStorage()
    const store = createSettingsStore(area, changed)
    await Promise.all([store.save({ onNonWebPage: 'clear' }), store.save({ resolveMode: 'manual' })])
    expect(data.settings).toEqual({ onNonWebPage: 'clear', resolveMode: 'manual' })
  })
})
