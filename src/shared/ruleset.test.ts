import { describe, expect, test } from 'vitest'
import { createRulesetStore, DEFAULT_RULESET, isBlocked, type Ruleset } from './ruleset'
import type { ChangeListener } from './storage'

function fakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  const listeners = new Set<ChangeListener>()
  const area = {
    get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
    set: async (items: Record<string, unknown>) => {
      Object.assign(data, items)
      for (const l of listeners) {
        l(Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }])), 'sync')
      }
    },
  }
  const changed = {
    addListener: (l: ChangeListener) => listeners.add(l),
    removeListener: (l: ChangeListener) => listeners.delete(l),
  }
  return { area, changed, data }
}

describe('ruleset store', () => {
  test('load returns defaults (empty canonical, seeded blocked) when empty', async () => {
    const { area, changed } = fakeStorage()
    const rs = await createRulesetStore(area, changed, 'sync').load()
    expect(rs.canonical).toEqual({})
    expect(Array.isArray(rs.blocked)).toBe(true)
    expect(rs).toEqual(DEFAULT_RULESET)
  })

  test('save merges a canonical rule; load reflects it', async () => {
    const { area, changed } = fakeStorage()
    const store = createRulesetStore(area, changed, 'sync')
    const next: Ruleset = { canonical: { 'news.ycombinator.com': { keepParams: ['id'] } }, blocked: [] }
    await store.save(next)
    expect((await store.load()).canonical['news.ycombinator.com']).toEqual({ keepParams: ['id'] })
  })

  test('watch fires on the sync area with merged value', async () => {
    const { area, changed } = fakeStorage()
    const store = createRulesetStore(area, changed, 'sync')
    const seen: Ruleset[] = []
    store.watch((r) => seen.push(r))
    await area.set({ ruleset: { canonical: { 'x.com': { pathRewrite: '/w' } }, blocked: [] } })
    expect(seen).toHaveLength(1)
    expect(seen[0].canonical['x.com']).toEqual({ pathRewrite: '/w' })
  })
})

describe('isBlocked', () => {
  test('exact registrable-domain match', () => {
    expect(isBlocked('example.com', ['example.com'])).toBe(true)
  })

  test('subdomain of a blocked registrable domain is blocked', () => {
    expect(isBlocked('mail.example.com', ['example.com'])).toBe(true)
  })

  test('unrelated domain is not blocked', () => {
    expect(isBlocked('example.org', ['example.com'])).toBe(false)
  })

  test('empty block-list blocks nothing', () => {
    expect(isBlocked('example.com', [])).toBe(false)
  })
})
