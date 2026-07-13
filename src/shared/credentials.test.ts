import { describe, expect, test } from 'vitest'
import { createCredentialsStore, normalizeRealmUrl, type Credentials } from './credentials'
import type { ChangeListener } from './storage'

const CREDS: Credentials = {
  realmUrl: 'https://zulip.example.com',
  email: 'me@x.com',
  apiKey: 'k',
  channelName: 'web-threads',
}

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

describe('credentials store', () => {
  test('load returns null when unconfigured', async () => {
    const { area, changed } = fakeStorage()
    expect(await createCredentialsStore(area, changed).load()).toBeNull()
  })

  test('save/load round-trips; clear returns to null', async () => {
    const { area, changed } = fakeStorage()
    const store = createCredentialsStore(area, changed)
    await store.save(CREDS)
    expect(await store.load()).toEqual(CREDS)
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  test('watch fires with credentials on save and null on clear', async () => {
    const { area, changed } = fakeStorage()
    const store = createCredentialsStore(area, changed)
    const seen: unknown[] = []
    store.watch((c) => seen.push(c))
    await store.save(CREDS)
    await store.clear()
    expect(seen).toEqual([CREDS, null])
  })
})

describe('normalizeRealmUrl', () => {
  test.each([
    ['https://acme.zulipchat.com', 'https://acme.zulipchat.com'],
    ['acme.zulipchat.com', 'https://acme.zulipchat.com'],
    ['https://acme.zulipchat.com/some/path?x=1', 'https://acme.zulipchat.com'],
    ['HTTPS://ACME.ZULIPCHAT.COM', 'https://acme.zulipchat.com'],
    ['http://localhost:9090', 'http://localhost:9090'],
    ['http://127.0.0.1:9090/login', 'http://127.0.0.1:9090'],
    ['  https://acme.zulipchat.com  ', 'https://acme.zulipchat.com'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRealmUrl(input)).toBe(expected)
  })

  test.each([['http://acme.zulipchat.com'], ['ftp://x.com'], [''], ['   '], ['not a url at all::'], ['http://192.168.1.5']])(
    'rejects %s',
    (input) => {
      expect(normalizeRealmUrl(input)).toBeNull()
    }
  )
})
