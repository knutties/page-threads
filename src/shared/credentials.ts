import { browser } from './browser'
import type { ChangeListener, StorageAreaLike, StorageChangedLike } from './storage'

export interface Credentials {
  realmUrl: string
  email: string
  apiKey: string
  channelName: string
}

export interface CredentialsStore {
  load(): Promise<Credentials | null>
  save(c: Credentials): Promise<void>
  clear(): Promise<void>
  watch(cb: (c: Credentials | null) => void): () => void
}

const KEY = 'credentials'

/** Whole-record writes (never merged), so there is no read-merge-write race here. */
export function createCredentialsStore(
  area: StorageAreaLike = browser.storage.local,
  changed: StorageChangedLike = browser.storage.onChanged,
  areaName = 'local'
): CredentialsStore {
  return {
    async load() {
      const stored = (await area.get(KEY))[KEY] as Credentials | null | undefined
      return stored ?? null
    },
    async save(c) {
      await area.set({ [KEY]: c })
    },
    async clear() {
      await area.set({ [KEY]: null })
    },
    watch(cb) {
      const listener: ChangeListener = (changes, name) => {
        if (name === areaName && changes[KEY]) {
          cb((changes[KEY].newValue as Credentials | null | undefined) ?? null)
        }
      }
      changed.addListener(listener)
      return () => changed.removeListener(listener)
    },
  }
}

/**
 * Realm input → pinned origin. https only, except plain-http dev realms on
 * localhost/127.0.0.1 (Chrome treats those as secure contexts).
 */
export function normalizeRealmUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    if (u.protocol === 'https:') return u.origin
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return u.origin
    }
    return null
  } catch {
    return null
  }
}
